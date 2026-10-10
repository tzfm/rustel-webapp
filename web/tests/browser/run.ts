// The browser test sequence. scripts/browser-test.ts bundles this file and adds
// the bundle to the built page, so the product page holds no test code. The
// sequence reaches the page through window.__rustelBench only.
//
// Three sessions: `scores` plays real scores and the hostile probe, `closed`
// meets a Worker script which came with no policy header, and `recovery`
// stops the Worker in four ways and watches the standby take over. Every
// session also reports the policy violations the app page saw. The `scores`
// session looks at the editor too.

import { ALLOWED_GLOBALS } from "../../src/engine/score/lockdown.ts";
import type { Position, Recovered, Refusal, Telemetry } from "../../src/protocol.ts";
import browserNames from "../conformance/firefox-worker-names.json";

/** A refused score: its message, and its place in the score text. */
export interface Refused {
  message: string;
  position?: Position;
}

/** A violation of the content security policy of the app page. */
export interface Violation {
  directive: string;
  blocked: string;
  sample: string;
}

declare global {
  interface Window {
    /** The violations the test server's watcher script saw. The script comes first on the page. */
    __violations?: Violation[];
  }
}

/** Peaks in the key test: while a score sounds after the play key, and after the stop key. */
export interface KeyPeaks {
  playing: number;
  stopped: number;
}

/** What the editor showed in the `scores` session. */
export interface EditorReport {
  /** The text of the editor at the start. */
  initial: string;
  /** True when `evaluate` put its text in the editor. */
  replaced: boolean;
  /** Style sheets the shadow root adopted, and style elements in the shadow root and the document. */
  adoptedSheets: number;
  styleElements: number;
  /** Computed colours: the gutter, the text of the editor and three tokens, and the colours
   * the custom properties of the page name for the gutter and for a keyword. */
  gutterBackground: string;
  expectedGutterBackground: string;
  contentColour: string;
  functionColour: string;
  nameColour: string;
  keywordColour: string;
  expectedKeywordColour: string;
  /** The place of the error mark after a syntax error, after an edit, and after an exception. */
  syntaxMark: Position | null;
  markAfterEdit: Position | null;
  thrownMark: Position | null;
  /** True when the mark of an error far down a long score sits inside the view of the editor. */
  longMarkInView: boolean;
  /** The keys, with Ctrl and with Cmd. */
  ctrl: KeyPeaks;
  meta: KeyPeaks;
}

/** What the hostile score reported for one capability. */
export interface Reach {
  state: "missing" | "failed" | "ok";
  detail: string;
}

/** One time a score stopped the Worker while a score played: what the page saw. */
export interface Episode {
  /** The refusal of the score which stopped the Worker. */
  refused?: Refused;
  /** Milliseconds from the call to the refusal. */
  waitMs: number;
  /** The message of the frame about the recovery. */
  recovered: Recovered | null;
  /** The highest peak over 1.5 s, from 1.2 s after the recovery. The old events end by then. */
  peakAfter: number;
  /** Late events and refused events during the episode. */
  late: number;
  refusedEvents: number;
  /** Generation of the renderer before the episode and at its end. */
  generationBefore: number;
  generationAfter: number;
  /** The lowest time the event ring covered ahead of the audio frame, in milliseconds. */
  lowestAheadMs: number;
  /** Events the pattern owed over the episode, less the events the renderer took. */
  lost: number;
}

/** The `recovery` session. */
export interface Recovery {
  /** The first score of the page hangs. */
  first?: Episode;
  /** A later Play works. */
  peakAfterFirstPlay?: number;
  hang?: Episode;
  /** An update after the recovery. */
  updateGenerationAfter?: number;
  peakAfterUpdate?: number;
  /** Stop while the Worker hangs: the peak at once, after the recovery, and after a Play. */
  peakStopDuringHang?: number;
  peakStoppedAfterRecovery?: number;
  peakPlayAfterStop?: number;
  stopRecovered?: Recovered | null;
  trap?: Episode;
  death?: Episode;
  /** A score which hangs inside a turn, with no score evaluating. */
  turnHang?: Episode;
  peakAfterTurnHangUpdate?: number;
  peakAfterStop?: number;
  late?: number;
}

/** The numbers of one run. scripts/browser-test.ts checks them. */
export interface Result {
  error?: string;
  isolated?: boolean;
  accepted?: number;
  late?: number;
  peakPlaying?: number;
  peakAfterStop?: number;
  generationBefore?: number;
  generationAfter?: number;
  allocations?: number;
  audio?: string;
  sampleRate?: number;
  /** Frames the renderer makes in one second, over the play window. */
  framesPerSecond?: number;
  agent?: string;
  /** The score with a syntax error: the refusal, then the sound and the generation. */
  syntax?: Refused;
  peakAfterSyntax?: number;
  generationAfterSyntax?: number;
  /** The score which throws. */
  thrown?: Refused;
  peakAfterThrown?: number;
  generationAfterThrown?: number;
  /** The peak of a score which uses `register`, and of one which runs a function at query time. */
  peakRegister?: number;
  peakQueryFunction?: number;
  /** The hostile probe: each capability with what the score saw, and the tricks. */
  probe?: Record<string, Reach>;
  tricks?: Record<string, unknown>;
  peakAfterProbe?: number;
  /** The `closed` session: the refusal of a Worker with no policy. */
  closed?: Refused;
  /** The `recovery` session. */
  recovery?: Recovery;
  /** Requests the test server saw on the canary path. The test server sets this field. */
  canary?: number;
  /** Requests the test server saw for the page icon. The test server sets this field. */
  icon?: number;
  /** The policy violations the app page saw over the session. */
  violations?: Violation[];
  /** The `scores` session: the editor. */
  editor?: EditorReport;
}

const PLAY_MS = 2000;

const bench = window.__rustelBench;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function snapshot(): Telemetry {
  const telemetry = bench.telemetry();
  if (telemetry === null) {
    throw new Error("The page has no telemetry.");
  }
  return telemetry;
}

/** The first telemetry object. The frame sends one for each animation frame,
 * so the first one arrives a moment after the engine starts. Waits 2 s at most. */
async function firstSnapshot(): Promise<Telemetry> {
  for (let waited = 0; waited < 2000 && bench.telemetry() === null; waited += 10) {
    await sleep(10);
  }
  return snapshot();
}

/** The highest peak seen over `ms`, read every 50 ms. */
async function peakOver(ms: number): Promise<number> {
  let peak = 0;
  for (let waited = 0; waited < ms; waited += 50) {
    await sleep(50);
    peak = Math.max(peak, bench.telemetry()?.peak ?? 0);
  }
  return peak;
}

/** The peak when the sound starts, read every 50 ms, or 0 after `ms`. An update
 * leaves a silent gap of up to one note before its first note. */
async function peakWhenSounding(ms: number): Promise<number> {
  for (let waited = 0; waited < ms; waited += 50) {
    await sleep(50);
    const peak = bench.telemetry()?.peak ?? 0;
    if (peak > 0) return peak;
  }
  return 0;
}

/** The refusal of a score, or undefined when the score ran. */
async function refusalOf(text: string): Promise<Refused | undefined> {
  return bench.evaluate(text).then(
    () => undefined,
    (error: Refusal) => ({ message: error.message, position: error.position }),
  );
}

/** The refusal of a Play of a score, or undefined when the score played. */
async function refusalOfPlay(text: string): Promise<Refused | undefined> {
  return bench.play(text).then(
    () => undefined,
    (error: Refusal) => ({ message: error.message, position: error.position }),
  );
}

/** The shadow root of the editor. The editor file arrives after the page, so this waits up to 5 s. */
async function editorRoot(): Promise<ShadowRoot> {
  for (let waited = 0; waited < 5000; waited += 10) {
    const root = document.getElementById("editor")?.shadowRoot;
    if (root?.querySelector(".cm-content")) return root;
    await sleep(10);
  }
  throw new Error("The editor did not arrive.");
}

function editorText(root: ShadowRoot): string {
  return [...root.querySelectorAll(".cm-line")].map((line) => line.textContent).join("\n");
}

/** The computed colour of the first token with this text. */
function tokenColour(root: ShadowRoot, text: string): string {
  const token = [...root.querySelectorAll(".cm-line span")].find(
    (span) => span.children.length === 0 && span.textContent === text,
  );
  if (token === undefined) {
    throw new Error(`The editor shows no token ${text}.`);
  }
  return getComputedStyle(token).color;
}

/** The computed colour a custom property of the page names. */
function propertyColour(name: string): string {
  const probe = document.createElement("span");
  probe.style.color = `var(${name})`;
  document.body.append(probe);
  const colour = getComputedStyle(probe).color;
  probe.remove();
  return colour;
}

/** The place of the error mark, from the editor DOM: the line, and the column
 * after the text in front of the mark. Null when the editor shows no mark. */
function markAt(root: ShadowRoot): Position | null {
  const mark = root.querySelector(".score-error, .score-error-tick");
  const line = mark?.closest(".cm-line");
  if (!mark || !line) return null;
  const front = document.createRange();
  front.setStart(line, 0);
  front.setEndBefore(mark);
  return {
    line: [...root.querySelectorAll(".cm-line")].indexOf(line) + 1,
    column: front.toString().length + 1,
  };
}

/** True when the error mark is inside the box of the editor scroller, and the scroller moved. */
function markInView(root: ShadowRoot): boolean {
  const mark = root.querySelector(".score-error, .score-error-tick")?.getBoundingClientRect();
  const scroller = root.querySelector(".cm-scroller");
  if (!mark || !scroller) return false;
  const view = scroller.getBoundingClientRect();
  return scroller.scrollTop > 0 && mark.top >= view.top && mark.bottom <= view.bottom;
}

/** Sends one key event to the editor, as a key press would. */
function press(root: ShadowRoot, key: string, modifier: "ctrlKey" | "metaKey" | null): void {
  const content = root.querySelector(".cm-content");
  if (content === null) throw new Error("The editor has no content element.");
  const modifiers = modifier === null ? {} : { [modifier]: true };
  content.dispatchEvent(
    new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...modifiers }),
  );
}

/** The play key, then the stop key, with one modifier. The peak is read while the
 * score sounds and 500 ms after the stop. */
async function keys(root: ShadowRoot, modifier: "ctrlKey" | "metaKey"): Promise<KeyPeaks> {
  press(root, "Enter", modifier);
  const playing = await peakWhenSounding(3000);
  press(root, ".", modifier);
  await sleep(500);
  return { playing, stopped: snapshot().peak };
}

/** Stops the sound, then plays a score from a silent start. Returns the peak
 * of the first 1.2 s, so a score which makes no event shows as 0. */
async function playFromSilence(text: string): Promise<number> {
  await bench.stop();
  await sleep(400);
  await bench.evaluate(text);
  await bench.play();
  return peakOver(1200);
}

// A long score with a syntax error in its last line. The error is out of view.
const LONG = `${"note('c3')\n".repeat(60)}note(`;
// A score with a chain of registry names, and an update of the score.
const CHAIN = 'note("c3 e3 g3 c4").s("sawtooth").every(2, rev).fast(2).gain(0.8)';
const UPDATE = 'note("c3 g3").s("sawtooth")';
// Double quotes make mini-notation in a score, so an ordinary string uses single quotes.
const SYNTAX = 'note("c3 e3")\n  .s("sawtooth"';
const THROWS = "note(\"c3 e3\")\nthrow new Error('boom');";
// `register` with a patterned argument runs the body in the query.
const REGISTER =
  'register(\'twice\', (n, pat) => pat.fast(n))\nnote("c3 e3 g3").s("sawtooth").twice("<2 4>")';
const QUERY_FUNCTION = 'note("c3 e3 g3").s("sawtooth").withValue((v) => ({ ...v, gain: 0.5 }))';

const names = (browserNames as string[]).filter((name) => !ALLOWED_GLOBALS.includes(name));
// Names a global scope has in a browser, and no list holds.
const guesses = [
  "window",
  "document",
  "top",
  "parent",
  "frames",
  "ShadowRealm",
  "uneval",
  "toSource",
];

/** The hostile score. The score tries each capability by name with a real
 * call, then the tricks which get a deleted name back. The score reports through the
 * message of a thrown error. Strings use single quotes, since double quotes make
 * mini-notation. The transpiler refuses the syntax `import()` in a score, so the
 * score builds the call from text, as hostile code does. */
function probeScore(app: string, engine: string): string {
  const socket = engine.replace("http", "ws");
  return `
const report = {};
const tricks = {};
const text = (error) => String((error && error.message) || error);
const attempt = async (name, run) => {
  try {
    report[name] = { state: 'ok', detail: String(await run()) };
  } catch (error) {
    report[name] = { state: error instanceof ReferenceError ? 'missing' : 'failed', detail: text(error) };
  }
};
const opens = (target, event) => new Promise((resolve, reject) => {
  target[event] = () => resolve('opened');
  target.onerror = () => reject(new Error('error event'));
});

await attempt('fetch', async () => (await fetch('/canary?c=fetch')).status);
await attempt('fetch, own origin by address', async () => (await fetch('${engine}/canary?c=fetch-engine')).status);
await attempt('fetch, other origin', async () => (await fetch('${app}/canary?c=fetch-app', { mode: 'no-cors' })).type);
await attempt('XMLHttpRequest', async () => {
  const request = new XMLHttpRequest();
  request.open('GET', '/canary?c=xhr', false);
  request.send();
  return request.status;
});
await attempt('WebSocket', () => opens(new WebSocket('${socket}/canary?c=ws'), 'onopen'));
await attempt('WebTransport', () => new WebTransport('https://localhost/canary?c=wt').ready);
await attempt('EventSource', () => opens(new EventSource('/canary?c=es'), 'onopen'));
await attempt('importScripts', async () => importScripts('/canary?c=importScripts'));
await attempt('import() of a path', async () => (await Function('return import("/canary?c=import")')()).default);
await attempt('import() of an address', async () => (await Function('return import("${engine}/canary?c=import-engine")')()).default);
await attempt('import() of the app origin', async () => (await Function('return import("${app}/canary?c=import-app")')()).default);
await attempt('import() of data:', async () => (await Function('return import("data:text/javascript,export default 7")')()).default);
await attempt('import() of data: through eval', async () => (await eval('import("data:text/javascript,export default 8")')).default);
await attempt('indexedDB', async () => indexedDB.open('probe'));
await attempt('caches', async () => caches.has('probe'));
await attempt('navigator', async () => navigator.userAgent);
await attempt('navigator.storage', async () => navigator.storage.getDirectory());
await attempt('navigator.locks', async () => navigator.locks.query());
await attempt('navigator.serviceWorker', async () => navigator.serviceWorker.register('/canary?c=sw'));
await attempt('BroadcastChannel', async () => new BroadcastChannel('probe').name);
await attempt('Worker', () => opens(new Worker('/canary?c=worker'), 'onmessage'));
await attempt('Worker from data:', () => opens(new Worker('data:text/javascript,postMessage(1)'), 'onmessage'));
await attempt('SharedArrayBuffer', async () => new SharedArrayBuffer(8).byteLength);
await attempt('SharedArrayBuffer from WebAssembly.Memory', async () => new WebAssembly.Memory({ initial: 1, maximum: 1, shared: true }).buffer.byteLength);
await attempt('WebAssembly', async () => typeof WebAssembly.Instance);
await attempt('Atomics', async () => Atomics.add(new Int32Array(4), 0, 1));
await attempt('postMessage', async () => postMessage({ from: 'score' }));
await attempt('setTimeout', async () => setTimeout(() => {}, 1));
await attempt('setInterval', async () => setInterval(() => {}, 1000));
await attempt('requestAnimationFrame', async () => requestAnimationFrame(() => {}));
await attempt('queueMicrotask', async () => queueMicrotask(() => {}));
await attempt('self', async () => self.name);
await attempt('location', async () => location.href);

// Trick: the four function constructors. Each one evaluates text in this same global.
tricks.constructors = {};
for (const [name, Maker, body] of [
  ['Function', (function () {}).constructor, 'return this'],
  ['AsyncFunction', (async function () {}).constructor, 'return this'],
  ['GeneratorFunction', (function* () {}).constructor, 'yield this'],
  ['AsyncGeneratorFunction', (async function* () {}).constructor, 'yield this'],
]) {
  try {
    let reached = await Maker(body)();
    if (body.startsWith('yield')) reached = (await reached.next()).value;
    tricks.constructors[name] = reached === globalThis ? 'same global' : 'other object';
  } catch (error) {
    tricks.constructors[name] = 'failed: ' + text(error);
  }
}

// Trick: climb the call stack to a function of the glue.
function climb() {
  const chain = [];
  try {
    for (let fn = climb.caller; fn && chain.length < 8; fn = fn.caller) chain.push(fn.name || '(no name)');
  } catch (error) {
    chain.push('stopped: ' + text(error));
  }
  return chain;
}
tricks.caller_chain = climb();

// Trick: guess the names of the glue.
tricks.glue_names = ['engine', 'bridge', 'layout', 'host', 'evaluator', 'transpiler', 'scope', 'post', 'every', 'lockdown', 'secured', 'policy', 'player', 'binding', 'openScoreHost'].filter((name) => {
  try {
    return typeof globalThis.eval(name) !== 'undefined';
  } catch {
    return false;
  }
});

// Trick: ask for every name the global listed before the lockdown.
const asked = '${[...names, ...guesses].join(" ")}'.split(' ');
tricks.names_asked = asked.length;
tricks.names_resolving = asked.filter((name) => !(name in Object.prototype) && typeof globalThis[name] !== 'undefined');

// Trick: replace what the glue uses later, then make the glue run.
const captured = [];
const notes = [];
const TypedArray = Object.getPrototypeOf(Uint8Array);
const lengthBefore = Object.getOwnPropertyDescriptor(TypedArray.prototype, 'length');
const arrayBefore = globalThis.Float64Array;
try {
  Object.defineProperty(TypedArray.prototype, 'length', {
    configurable: true,
    get() {
      captured.push(this);
      return Reflect.apply(lengthBefore.get, this, []);
    },
  });
  notes.push('length getter replaced');
} catch (failure) {
  notes.push('length getter: ' + text(failure));
}
try {
  globalThis.Float64Array = new Proxy(arrayBefore, {
    construct(target, args) {
      captured.push(args[0]);
      return Reflect.construct(target, args);
    },
  });
  notes.push('Float64Array replaced');
} catch (failure) {
  notes.push('Float64Array: ' + text(failure));
}
try {
  note('c3 e3').s('sawtooth').fast(2);
} catch (failure) {
  notes.push('glue: ' + text(failure));
}
try {
  Object.defineProperty(TypedArray.prototype, 'length', lengthBefore);
  globalThis.Float64Array = arrayBefore;
} catch {}
tricks.replace_glue_parts = { notes, captured: captured.length };

throw new Error(JSON.stringify({ report, tricks }));
`;
}

/** The origin of the engine frame, from the frame element of the page. */
function engineOrigin(): string {
  const frame = document.getElementById("engine") as HTMLIFrameElement | null;
  if (frame === null) {
    throw new Error("The page has no engine frame.");
  }
  return new URL(frame.src).origin;
}

interface Report {
  report: Record<string, Reach>;
  tricks: Record<string, unknown>;
}

/** The report of the hostile score, which comes as the message of its error. */
function parseReport(hostile: Refused | undefined): Report {
  try {
    return JSON.parse(hostile?.message ?? "") as Report;
  } catch {
    throw new Error(`The hostile score did not report: ${hostile?.message.slice(0, 400)}`);
  }
}

async function scores(result: Result): Promise<void> {
  const root = await editorRoot();
  const initial = editorText(root);
  const functionColour = tokenColour(root, "setcps");
  const nameColour = tokenColour(root, "c3");
  await bench.evaluate(CHAIN);
  const replaced = editorText(root) === CHAIN;
  await bench.play();
  const first = await firstSnapshot();
  const began = performance.now();
  let peakPlaying = await peakOver(PLAY_MS);
  const last = snapshot();
  result.framesPerSecond = (1000 * (last.frame - first.frame)) / (performance.now() - began);
  result.sampleRate = last.sampleRate;
  result.generationBefore = last.generation;
  result.generationAfter = await bench.evaluate(UPDATE);
  peakPlaying = Math.max(peakPlaying, await peakWhenSounding(1500));

  // A score which fails changes nothing: the sound and the generation stay.
  result.syntax = await refusalOf(SYNTAX);
  const syntaxMark = markAt(root);
  // The edit: to the end of the text, then one character off. The mark goes.
  press(root, "End", "ctrlKey");
  press(root, "Backspace", null);
  await sleep(50);
  const markAfterEdit = markAt(root);
  result.peakAfterSyntax = await peakOver(500);
  result.generationAfterSyntax = bench.telemetry()?.generation;
  result.thrown = await refusalOf(THROWS);
  const thrownMark = markAt(root);
  const keywordColour = tokenColour(root, "throw");
  result.peakAfterThrown = await peakOver(500);
  result.generationAfterThrown = bench.telemetry()?.generation;

  result.peakRegister = await playFromSilence(REGISTER);
  result.peakQueryFunction = await playFromSilence(QUERY_FUNCTION);

  const hostile = await refusalOf(probeScore(location.origin, engineOrigin()));
  const reported = parseReport(hostile);
  result.probe = reported.report;
  result.tricks = reported.tricks;
  result.peakAfterProbe = await peakOver(500);

  await bench.stop();
  await sleep(500);
  const end = bench.telemetry();
  result.peakPlaying = peakPlaying;
  result.peakAfterStop = end?.peak;
  result.isolated = end?.isolated;
  result.accepted = end?.accepted;
  result.late = end?.late;
  result.audio = end?.audio;
  result.allocations = await bench.allocations();

  // The mark of an error far down a long score scrolls into view.
  await refusalOf(LONG);
  await sleep(200);
  const longMarkInView = markInView(root);

  // The keys of the editor. The score is UPDATE, and the session stays silent.
  await bench.evaluate(UPDATE);
  const ctrl = await keys(root, "ctrlKey");
  const meta = await keys(root, "metaKey");
  const content = getComputedStyle(root.querySelector(".cm-content") as Element);
  result.editor = {
    initial,
    replaced,
    adoptedSheets: root.adoptedStyleSheets.length,
    styleElements:
      root.querySelectorAll("style").length + document.querySelectorAll("style").length,
    gutterBackground: getComputedStyle(root.querySelector(".cm-gutters") as Element)
      .backgroundColor,
    expectedGutterBackground: propertyColour("--editor-gutter-bg"),
    contentColour: content.color,
    functionColour,
    nameColour,
    keywordColour,
    expectedKeywordColour: propertyColour("--tok-keyword"),
    syntaxMark,
    markAfterEdit,
    thrownMark,
    longMarkInView,
    ctrl,
    meta,
  };
}

async function closed(result: Result): Promise<void> {
  result.closed = await refusalOf("note('c3')");
}

// The scores of the `recovery` session. Twelve events a second at one cycle a
// second: a gap of half a second shows as six events.
const PLAY = 'setcps(1)\nnote("c3*12").s("sawtooth").gain(0.2)';
const HANG = "while (true) {}";
// The function runs when the queries reach new events. After 1.5 s the function never returns.
const HANG_LATER =
  'const born = Date.now();\nnote("c3*12").s("sawtooth").gain(0.2).withValue((v) => {\n  while (Date.now() - born > 1500) {}\n  return v;\n})';
// The test server puts a hook in front of the Worker script in this session.
const TRAP = "// test:trap";
const DEATH = "// test:death";
const EVENTS_PER_SECOND = 12;

/** Starts PLAY from silence and waits until the ring is full. */
async function playFromQuiet(text = PLAY): Promise<void> {
  await bench.evaluate(text);
  await bench.play();
  await sleep(2500);
}

/** Watches the telemetry every 5 ms: the lowest time ahead, in milliseconds. */
function watchAhead() {
  const seen = { lowest: Number.POSITIVE_INFINITY };
  const timer = setInterval(() => {
    const telemetry = bench.telemetry();
    if (telemetry !== null && telemetry.ahead > 0) {
      seen.lowest = Math.min(seen.lowest, (1000 * telemetry.ahead) / telemetry.sampleRate);
    }
  }, 5);
  return { seen, stop: () => clearInterval(timer) };
}

/**
 * Sends a score which stops the Worker while PLAY plays, and watches the page
 * from the call until 2.7 s after the recovery.
 */
async function episode(
  score: string,
  plays: boolean,
  send: (text: string) => Promise<Refused | undefined> = refusalOf,
): Promise<Episode> {
  // The first score of the page starts the engine, so there is no telemetry yet.
  const before = bench.telemetry();
  const known = bench.recovery();
  const watcher = watchAhead();
  const began = performance.now();
  const refused = await send(score);
  const waitMs = performance.now() - began;
  const recovered = bench.recovery() === known ? null : bench.recovery();
  await sleep(1200);
  const peakAfter = await peakOver(1500);
  watcher.stop();
  const after = snapshot();
  const seconds = (after.frame - (before?.frame ?? 0)) / after.sampleRate;
  return {
    refused,
    waitMs,
    recovered,
    peakAfter,
    late: after.late - (before?.late ?? 0),
    refusedEvents: after.refused - (before?.refused ?? 0),
    generationBefore: before?.generation ?? 0,
    generationAfter: after.generation,
    lowestAheadMs: watcher.seen.lowest,
    // A pattern which keeps playing owes 12 events a second. A count is within one of the number.
    lost: plays
      ? Math.round(seconds * EVENTS_PER_SECOND - (after.accepted - (before?.accepted ?? 0)))
      : Number.NaN,
  };
}

async function recovery(result: Result): Promise<void> {
  const out: Recovery = {};
  result.recovery = out;

  // The first score of the page hangs: no earlier score, so the sound is silent.
  out.first = await episode(HANG, false, refusalOfPlay);
  await playFromQuiet();
  out.peakAfterFirstPlay = await peakOver(1200);

  // A hang while PLAY plays: the earlier score plays on, and an update works.
  out.hang = await episode(HANG, true);
  out.updateGenerationAfter = await bench.evaluate(UPDATE);
  out.peakAfterUpdate = await peakOver(1200);

  // Stop while the Worker hangs: the stop word silences the sound at once, the
  // recovery keeps the stop, and a later Play works.
  await playFromQuiet();
  const hung = refusalOf(HANG);
  await sleep(200);
  await bench.stop();
  await sleep(400);
  out.peakStopDuringHang = await peakOver(300);
  await hung;
  await sleep(300);
  out.stopRecovered = bench.recovery();
  out.peakStoppedAfterRecovery = await peakOver(1500);
  await playFromQuiet();
  out.peakPlayAfterStop = await peakOver(1200);

  // The engine module traps, and the Worker dies. The earlier score plays on.
  out.trap = await episode(TRAP, true);
  out.death = await episode(DEATH, true);

  // A score hangs inside a turn long after its evaluation. No score is
  // evaluating, so the playing score is to blame and the sound stops.
  const known = bench.recovery();
  await playFromQuiet(HANG_LATER);
  for (let waited = 0; waited < 5000 && bench.recovery() === known; waited += 50) {
    await sleep(50);
  }
  const recovered = bench.recovery() === known ? null : bench.recovery();
  // The old events in the ring play for another second.
  await sleep(1200);
  const turnHang: Episode = {
    waitMs: Number.NaN,
    recovered,
    peakAfter: await peakOver(1500),
    late: 0,
    refusedEvents: 0,
    generationBefore: 0,
    generationAfter: snapshot().generation,
    lowestAheadMs: Number.NaN,
    lost: Number.NaN,
  };
  out.turnHang = turnHang;
  await bench.evaluate(PLAY);
  out.peakAfterTurnHangUpdate = await peakOver(1500);

  await bench.stop();
  await sleep(500);
  out.peakAfterStop = snapshot().peak;
  out.late = snapshot().late;
}

async function run(): Promise<Result> {
  const result: Result = { agent: navigator.userAgent };
  try {
    const session = new URLSearchParams(location.search).get("session");
    if (session === "closed") {
      await closed(result);
    } else if (session === "recovery") {
      await recovery(result);
    } else {
      await scores(result);
    }
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error);
  }
  result.violations = window.__violations ?? [];
  return result;
}

const result = await run();
// A navigation carries the result, so the product headers stay as shipped. The
// test server answers 204, and the page stays.
location.replace(`/result?${encodeURIComponent(JSON.stringify(result))}`);
