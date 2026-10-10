// Plays the page in headless Firefox with a fresh profile and checks the
// numbers. Two servers on free ports stand for the two sites. The test server
// adds web/tests/browser/run.ts to the built page. The sequence runs through
// window.__rustelBench and reports the result to the test server.
//
// Three sessions, each in its own Firefox. The `scores` session runs with the
// product headers: real scores, and a hostile score which tries to reach the
// network, the storage, shared memory and the timers. The test server counts the requests on
// the canary path /canary. The `closed` session sends the Worker script with no
// policy header, and the Worker must refuse a score. The `recovery` session
// stops the Worker with a hang, a trap and a death, and the standby must take
// over. The test server puts the hook of web/tests/browser/worker-hook.js in
// front of the Worker script in this session, since no score traps the module.
// The `scores` session also looks at the editor. In each session the browser
// asks for the page icon, and the app page must see 0 violations of its content
// security policy: a watcher script, the first script of the page, counts the
// events.
//
//     node scripts/browser-test.ts
//
// The options --session NAME and --repeat N run one session N times, one line per run.
//
// Nothing is audible: the profile sets the volume scale to 0. Firefox starts
// as its own process group, and the group ends the run. The script touches no
// other process.

import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { build } from "esbuild";
import { type Position, recoveryText } from "../web/src/protocol.ts";
import type { Episode, Refused, Result } from "../web/tests/browser/run.ts";
import { bundle, root } from "./build.ts";
import { type Kind, type Send, serve, WORKER_PATH } from "./serve.ts";

const TIMEOUT_MS = 120_000;
/** Milliseconds Firefox gets to exit after SIGTERM, before SIGKILL. */
const EXIT_MS = 1500;

const PREFS: Record<string, string | number | boolean> = {
  // No sound reaches the speakers.
  "media.volume_scale": "0.0",
  // A headless run has no trusted click.
  "media.autoplay.default": 0,
  "browser.shell.checkDefaultBrowser": false,
  "browser.aboutwelcome.enabled": false,
  "browser.startup.homepage_override.mstone": "ignore",
  "startup.homepage_welcome_url": "about:blank",
  "startup.homepage_welcome_url.additional": "",
  "datareporting.policy.dataSubmissionEnabled": false,
  "toolkit.telemetry.reportingpolicy.firstRun": false,
  "browser.tabs.warnOnClose": false,
  "browser.sessionstore.resume_from_crash": false,
  "app.update.enabled": false,
};

function writeProfile(profile: string): void {
  const lines = Object.entries(PREFS).map(
    ([name, value]) => `user_pref(${JSON.stringify(name)}, ${JSON.stringify(value)});`,
  );
  writeFileSync(join(profile, "user.js"), `${lines.join("\n")}\n`);
  // Check the file before the first run: a missing line would make sound.
  if (
    !readFileSync(join(profile, "user.js"), "utf8").includes(
      'user_pref("media.volume_scale", "0.0");',
    )
  ) {
    throw new Error("the test profile does not set media.volume_scale to 0.0");
  }
}

async function endGroup(child: ChildProcess, pid: number): Promise<void> {
  const alive = () => child.exitCode === null && child.signalCode === null;
  const signal = (name: NodeJS.Signals) => {
    try {
      process.kill(-pid, name);
    } catch {
      // The group is gone.
    }
  };
  signal("SIGTERM");
  if (alive()) {
    await once(child, "exit", { signal: AbortSignal.timeout(EXIT_MS) }).catch(() => undefined);
  }
  if (alive()) {
    signal("SIGKILL");
  }
}

type Check = [string, boolean];

/** The score the page starts with. */
const DEFAULT_SCORE = 'setcps(0.5)\nnote("c3 e3 g3 c4").s("sawtooth")';

/** The first script of the test page. The script records the events of the policy. */
const WATCHER = `window.__violations = [];
document.addEventListener("securitypolicyviolation", (event) => {
  window.__violations.push({
    directive: event.effectiveDirective,
    blocked: event.blockedURI,
    sample: event.sample,
  });
});
`;

const num = (value: number | undefined) => value ?? Number.NaN;

/** True when the refusal has a message with the text. */
const says = (refused: Refused | undefined, text: string) =>
  refused?.message.includes(text) ?? false;

/** Names whose state is not "missing" or "failed": the score reached them. */
const reached = (probe: Result["probe"]) =>
  Object.entries(probe ?? {})
    .filter(([, reach]) => reach.state === "ok")
    .map(([name]) => name);

/** The tricks which found something. A constructor must return the same global. */
function found(tricks: Result["tricks"]): string[] {
  const trick = (name: string) => (tricks?.[name] ?? []) as string[];
  const constructors = Object.entries((tricks?.constructors ?? {}) as Record<string, string>)
    .filter(([, outcome]) => outcome !== "same global")
    .map(([name]) => `${name} constructor`);
  const chain = trick("caller_chain").filter((entry) => !entry.startsWith("stopped"));
  const replaced = (tricks?.replace_glue_parts ?? {}) as { captured?: number; notes?: string[] };
  const notes = (replaced.notes ?? []).filter((note) => note.endsWith("replaced"));
  return [
    ...constructors,
    ...chain.map((name) => `caller ${name}`),
    ...trick("glue_names").map((name) => `glue name ${name}`),
    ...trick("names_resolving").map((name) => `name ${name}`),
    ...notes,
    ...(replaced.captured ? [`${replaced.captured} objects captured`] : []),
  ];
}

function scoreChecks(result: Result): Check[] {
  const probed = Object.keys(result.probe ?? {}).length;
  return [
    [
      "the frame counter runs at the sample rate",
      Math.abs(num(result.framesPerSecond) - num(result.sampleRate)) <=
        0.2 * num(result.sampleRate),
    ],
    ["the frame is cross-origin isolated", result.isolated === true],
    ["events accepted above 0", num(result.accepted) > 0],
    ["late events 0", result.late === 0],
    ["peak above 0 while playing", num(result.peakPlaying) > 0],
    ["peak 0 after stop", result.peakAfterStop === 0],
    ["generation rose on the update", num(result.generationAfter) > num(result.generationBefore)],
    ["render allocations 0", result.allocations === 0],
    [
      "a syntax error is refused with its place in the score",
      says(result.syntax, "Expected") &&
        result.syntax?.position?.line === 2 &&
        result.syntax.position.column === 16,
    ],
    ["the sound goes on after a syntax error", num(result.peakAfterSyntax) > 0],
    [
      "the generation stays after a syntax error",
      result.generationAfterSyntax === result.generationAfter,
    ],
    [
      "a score which throws is refused with its message and place",
      result.thrown?.message === "boom" &&
        result.thrown.position?.line === 2 &&
        result.thrown.position.column === 7,
    ],
    ["the sound goes on after a throw", num(result.peakAfterThrown) > 0],
    ["the generation stays after a throw", result.generationAfterThrown === result.generationAfter],
    ["a score with register plays", num(result.peakRegister) > 0],
    ["a score with a function at query time plays", num(result.peakQueryFunction) > 0],
    ["the hostile score tried 30 capabilities or more", probed >= 30],
    ["the hostile score reached no capability", reached(result.probe).length === 0],
    ["the hostile score found no trick", found(result.tricks).length === 0],
    ["the test server saw 0 canary requests", result.canary === 0],
    ["the sound goes on after the hostile score", num(result.peakAfterProbe) > 0],
  ];
}

const at = (place: Position | null | undefined, line: number, column: number) =>
  place?.line === line && place.column === column;

/** The editor looks styled when the colours of its parts are the colours of the page. */
function editorChecks(result: Result): Check[] {
  const editor = result.editor;
  return [
    ["the editor holds the default score", editor?.initial === DEFAULT_SCORE],
    ["evaluate puts its text in the editor", editor?.replaced === true],
    [
      "the editor gets its styles from an adopted sheet, with no style element",
      num(editor?.adoptedSheets) >= 1 && editor?.styleElements === 0,
    ],
    [
      "the line number gutter has the colour --editor-gutter-bg of the page",
      editor?.gutterBackground === editor?.expectedGutterBackground &&
        editor?.gutterBackground !== "rgba(0, 0, 0, 0)",
    ],
    [
      "a keyword has the colour --tok-keyword of the page, not the colour of the text",
      editor?.keywordColour === editor?.expectedKeywordColour &&
        editor?.keywordColour !== editor?.contentColour,
    ],
    [
      "a called name and a mini-notation name differ from the text and from each other",
      editor?.functionColour !== editor?.contentColour &&
        editor?.nameColour !== editor?.contentColour &&
        editor?.functionColour !== editor?.nameColour,
    ],
    ["a syntax error puts the mark at line 2, column 16", at(editor?.syntaxMark, 2, 16)],
    ["an edit removes the mark", editor?.markAfterEdit === null],
    ["an exception puts the mark at line 2, column 7", at(editor?.thrownMark, 2, 7)],
    ["an error far down a long score is scrolled into view", editor?.longMarkInView === true],
    [
      "Ctrl+Enter plays and Ctrl+. stops",
      num(editor?.ctrl.playing) > 0 && editor?.ctrl.stopped === 0,
    ],
    [
      "Cmd+Enter plays and Cmd+. stops",
      num(editor?.meta.playing) > 0 && editor?.meta.stopped === 0,
    ],
  ];
}

function closedChecks(result: Result): Check[] {
  return [
    [
      "the Worker with no policy refuses a score with the policy message",
      says(result.closed, "no content security policy"),
    ],
    ["the test server saw 0 canary requests", result.canary === 0],
  ];
}

/** The checks of an episode in which a score stopped the Worker and the earlier score plays on. */
function playsOn(name: string, episode: Episode | undefined, reason: string): Check[] {
  const recovered = episode?.recovered;
  return [
    [
      `${name}: the page gets the message within 2 s`,
      num(episode?.waitMs) < 2000 &&
        recovered?.reason === reason &&
        says(episode?.refused, recoveryText(recovered.reason, true)),
    ],
    [`${name}: the earlier score plays on`, recovered?.kept === true],
    [`${name}: the sound goes on (peak above 0)`, num(episode?.peakAfter) > 0],
    [`${name}: no event is lost`, Math.abs(num(episode?.lost)) <= 1],
    [`${name}: late events 0`, episode?.late === 0],
    [`${name}: no event is refused`, episode?.refusedEvents === 0],
    [
      `${name}: the generation rose by the promotion`,
      num(episode?.generationAfter) > num(episode?.generationBefore),
    ],
  ];
}

function recoveryChecks(result: Result): Check[] {
  const out = result.recovery;
  const first = out?.first;
  const hang = out?.hang;
  const turn = out?.turnHang;
  return [
    [
      "first score hangs: the page gets the message",
      first?.recovered?.reason === "hang" &&
        first.recovered.kept === false &&
        says(first.refused, recoveryText("hang", false)),
    ],
    ["first score hangs: a later Play works", num(out?.peakAfterFirstPlay) > 0],
    ...playsOn("hang", hang, "hang"),
    ["hang: the ring covers the gap (lowest cover above 0.5 s)", num(hang?.lowestAheadMs) > 500],
    [
      "hang: an update after the promotion works",
      num(out?.updateGenerationAfter) > num(hang?.generationAfter) && num(out?.peakAfterUpdate) > 0,
    ],
    ["stop while the Worker hangs: peak 0 at once", out?.peakStopDuringHang === 0],
    [
      "stop while the Worker hangs: the stop holds after the recovery",
      out?.peakStoppedAfterRecovery === 0 &&
        out.stopRecovered?.reason === "hang" &&
        out.stopRecovered.kept === false,
    ],
    ["stop while the Worker hangs: a later Play works", num(out?.peakPlayAfterStop) > 0],
    ...playsOn("trap", out?.trap, "trap"),
    ...playsOn("death", out?.death, "death"),
    [
      "a hang inside a turn blames the playing score: the sound stops",
      turn?.recovered?.reason === "hang" && turn.recovered.kept === false && turn.peakAfter === 0,
    ],
    ["a hang inside a turn: an update works", num(out?.peakAfterTurnHangUpdate) > 0],
    ["peak 0 after stop", out?.peakAfterStop === 0],
    ["late events 0", out?.late === 0],
  ];
}

/** The smoke numbers of the hang episode, for the person who reads the log. */
function recoveryNumbers(result: Result): string {
  const hang = result.recovery?.hang;
  const recovered = hang?.recovered;
  return [
    `detect ${recovered?.detectMs.toFixed(0)} ms`,
    `promote ${recovered?.promoteMs.toFixed(0)} ms`,
    `page message ${hang?.waitMs.toFixed(0)} ms`,
    `lowest cover ${hang?.lowestAheadMs.toFixed(0)} ms`,
    `events lost ${hang?.lost}`,
  ].join(", ");
}

function checks(session: Session, result: Result): Check[] {
  const own = {
    scores: (result: Result) => [...scoreChecks(result), ...editorChecks(result)],
    closed: closedChecks,
    recovery: recoveryChecks,
  }[session.name];
  return [
    ["no error in the page", result.error === undefined],
    ["the browser asked for the page icon", num(result.icon) > 0],
    ["the app page saw 0 policy violations", result.violations?.length === 0],
    ...own(result),
  ];
}

interface Session {
  name: "scores" | "closed" | "recovery";
  /** False sends the Worker script with no policy header. */
  workerPolicy: boolean;
  /** True puts the test hook in front of the Worker script. */
  hook?: boolean;
}

const SESSIONS: Session[] = [
  { name: "scores", workerPolicy: true },
  { name: "closed", workerPolicy: false },
  { name: "recovery", workerPolicy: true, hook: true },
];

const outDir = join(root, "out/browser-test");
const HOOK_PATH = join(root, "web/tests/browser/worker-hook.js");
/** The path of the page icon on the app site. */
const ICON_PATH = "/icon.svg";
let session: Session = SESSIONS[0];
let posted: (result: Result) => void = () => undefined;
/** The requests on the canary path, of both servers, in this session. */
let canaries: string[] = [];
/** The requests for the page icon in this session. */
let icons = 0;

// Serves the built page with the test script added, the test script itself,
// and takes the result. The canary path counts each request and answers a
// script, so a request which gets out shows in the count. The Worker script of a
// session with no policy header goes out here, with no policy.
async function intercept(kind: Kind, request: IncomingMessage, send: Send): Promise<boolean> {
  const { pathname, search } = new URL(request.url ?? "/", "http://localhost");
  if (pathname === "/canary") {
    canaries.push(`${kind} ${request.method} ${pathname}${search}`);
    send(200, "text/javascript; charset=utf-8", "export default 1;");
    return true;
  }
  if (request.method !== "GET") {
    return false;
  }
  if (kind === "app" && pathname === ICON_PATH) {
    icons += 1;
  }
  if (kind === "engine") {
    if (pathname === WORKER_PATH && (!session.workerPolicy || session.hook)) {
      const script = readFileSync(join(outDir, "engine", WORKER_PATH), "utf8");
      const hook = session.hook ? readFileSync(HOOK_PATH, "utf8") : "";
      // The hook comes first, so the hook sees each message before the glue.
      send(
        200,
        "text/javascript; charset=utf-8",
        hook + script,
        session.workerPolicy ? [] : ["Content-Security-Policy"],
      );
      return true;
    }
    return false;
  }
  if (pathname === "/") {
    const page = readFileSync(join(outDir, "app/index.html"), "utf8");
    const watcher = '<script src="watcher.js"></script>';
    const tag = '<script type="module" src="test.js"></script>';
    send(
      200,
      "text/html; charset=utf-8",
      page.replace("<head>", `<head>${watcher}`).replace("</head>", `${tag}</head>`),
    );
    return true;
  }
  if (pathname === "/watcher.js") {
    send(200, "text/javascript; charset=utf-8", WATCHER);
    return true;
  }
  if (pathname === "/test.js") {
    send(200, "text/javascript; charset=utf-8", readFileSync(join(outDir, "test/run.js")));
    return true;
  }
  if (pathname === "/result") {
    posted(JSON.parse(decodeURIComponent(search.slice(1))));
    send(204, "text/plain", "");
    return true;
  }
  return false;
}

/** Plays one session in a Firefox of its own. */
async function runSession(origin: string, which: Session): Promise<Result> {
  session = which;
  canaries = [];
  icons = 0;
  const profile = mkdtempSync(join(tmpdir(), "rustel-firefox-"));
  const arrived = new Promise<Result>((resolve) => {
    posted = resolve;
  });
  let child: ChildProcess | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let result: Result;
  try {
    writeProfile(profile);
    const url = `${origin}/?session=${which.name}`;
    const flags = ["--no-remote", "--new-instance", "--profile", profile, "--headless", url];
    const firefox = spawn("firefox", flags, { detached: true, stdio: "ignore" });
    child = firefox;
    const failed = new Promise<never>((_, reject) => firefox.on("error", reject));
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`no result within ${TIMEOUT_MS / 1000} s`)),
        TIMEOUT_MS,
      );
    });
    result = await Promise.race([arrived, failed, timeout]);
  } catch (error) {
    result = { error: error instanceof Error ? error.message : String(error) };
  } finally {
    clearTimeout(timer);
    if (child?.pid !== undefined) {
      await endGroup(child, child.pid);
    }
    rmSync(profile, { recursive: true, force: true });
  }
  return { ...result, canary: canaries.length, icon: icons };
}

/** Late events over a session, or undefined for a session which counts none. */
const lateOf = (which: Session, result: Result) =>
  which.name === "recovery" ? result.recovery?.late : result.late;

/** Prints the numbers of one session and the line of each check. */
function report(which: Session, result: Result, results: Check[]): void {
  console.log(`\n== session ${which.name}`);
  console.log(JSON.stringify(result, null, 2));
  if (canaries.length > 0) {
    console.log(`canary requests: ${canaries.join(", ")}`);
  }
  for (const [name, ok] of results) {
    console.log(`${ok ? "pass" : "FAIL"}  ${which.name}: ${name}`);
  }
  if (which.name === "recovery") {
    console.log(`recovery numbers: ${recoveryNumbers(result)}`);
  }
}

const { values: options } = parseArgs({
  options: { session: { type: "string" }, repeat: { type: "string" } },
});
const planned = SESSIONS.filter(
  (one) => options.session === undefined || one.name === options.session,
);
const repeat = Number(options.repeat ?? 1);
if (planned.length === 0 || !Number.isInteger(repeat) || repeat < 1) {
  console.error(
    "usage: node scripts/browser-test.ts [--session scores|closed|recovery] [--repeat N]",
  );
  process.exit(2);
}

let running: Awaited<ReturnType<typeof serve>> | undefined;
let failed = false;
try {
  running = await serve(
    {
      app: { host: "127.0.0.1", port: 0, root: join(outDir, "app") },
      engine: { host: "localhost", port: 0, root: join(outDir, "engine") },
    },
    {
      intercept,
      upgrade: (kind, request) => {
        canaries.push(`${kind} UPGRADE ${request.url}`);
      },
    },
  );
  await bundle({ outDir, appOrigin: running.appOrigin, engineOrigin: running.engineOrigin });
  // The bundle step clears outDir, so the test script comes after.
  await build({
    entryPoints: [join(root, "web/tests/browser/run.ts")],
    outfile: join(outDir, "test/run.js"),
    bundle: true,
    format: "esm",
    logLevel: "warning",
  });

  const late: Record<string, number> = {};
  for (let run = 1; run <= repeat; run += 1) {
    for (const which of planned) {
      const result = await runSession(running.appOrigin, which);
      const results = checks(which, result);
      failed ||= results.some(([, ok]) => !ok);
      if (repeat === 1) {
        report(which, result, results);
        continue;
      }
      const count = lateOf(which, result);
      if (count !== undefined) late[which.name] = (late[which.name] ?? 0) + (count > 0 ? 1 : 0);
      const names = results.filter(([, ok]) => !ok).map(([name]) => name);
      console.log(
        `${which.name} run ${run}: late ${count ?? "-"}, failed: ${names.join(", ") || "none"}`,
      );
    }
  }
  for (const [name, runs] of Object.entries(late)) {
    console.log(`${name}: ${runs} of ${repeat} runs with late events`);
  }
} catch (error) {
  console.log(`FAIL  ${error instanceof Error ? error.message : String(error)}`);
  failed = true;
} finally {
  await running?.close();
}
process.exitCode = failed ? 1 : 0;
