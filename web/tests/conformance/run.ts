// The conformance run. For each committed score of the pinned engine: the
// transpiler module rewrites the text, a fresh instance of the engine module
// evaluates the result, cycles 0 to 4 are queried, and the hap count, the
// digest and the context sum are compared with the golden row of the engine.
//
//     node web/tests/conformance/run.ts [--out <file>] [--only <prefix>] [--lockdown off]
//
// A worker applies the lockdown of the score Worker before its first score
// (see `worker.ts`). `--lockdown off` runs with no lockdown, for a comparison
// by hand.
//
// Every score ends in exactly one class:
//
//   pass         count, digest and context sum equal the golden row
//   missing      the score needs a name the binding does not install
//   unsupported  a clear refusal of the binding
//   error        any other exception, a query which threw, or the time limit
//   wrong        the score evaluates and the digest differs
//
// `expected.json` names each score which is not a pass. The run fails when
// the set differs from the file in any direction, when no score ran, or when
// a score has no class.
//
// A score runs in a worker, so a hang ends at the time limit and a trap ends
// one score and nothing else.

import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { Worker } from "node:worker_threads";
import { compile } from "../../src/engine/score/score.ts";
import { createTranspiler } from "../../src/engine/transpiler.ts";
import type { Job, Outcome } from "./worker.ts";

const root = resolve(import.meta.dirname, "../../..");
const release = join(root, "target/wasm32-unknown-unknown/release");

const CLASSES = ["pass", "missing", "unsupported", "error", "wrong"] as const;
type Class = (typeof CLASSES)[number];

/** The words of the binding in the refusal of a callback or a value. */
const REFUSAL = "not supported by the binding";
/** Scores a worker serves before the worker starts again: dropped instances free memory late. */
const MAX_SERVED = 200;
const WORKER_LIMIT = 12;
/** Lines of the failure report. */
const MAX_PROBLEMS = 20;

interface Settings {
  engineWasm: string;
  transpilerWasm: string;
  out: string | undefined;
  only: string;
  workers: number;
  timeout: number;
  lockdown: boolean;
}

function settings(argv: string[]): Settings {
  const flags = new Map<string, string>();
  for (let at = 0; at < argv.length; at += 2) flags.set(argv[at].replace(/^--/, ""), argv[at + 1]);
  return {
    engineWasm: flags.get("wasm") ?? join(release, "rustel_web_engine.wasm"),
    transpilerWasm: flags.get("transpiler") ?? join(release, "rustel_web_transpiler.wasm"),
    out: flags.get("out"),
    only: flags.get("only") ?? "",
    workers: Number(flags.get("workers") ?? Math.min(WORKER_LIMIT, availableParallelism())),
    timeout: Number(flags.get("timeout") ?? 30_000),
    lockdown: flags.get("lockdown") !== "off",
  };
}

interface Golden {
  case: string;
  haps: number;
  haps_sha256: string;
  ctx: number;
}

interface Score {
  name: string;
  text: string;
  golden: Golden | undefined;
}

/** The scores and the golden rows sit in the checkout of the pinned engine, which cargo holds. */
function scoresOfTheEngine(): Score[] {
  const metadata = JSON.parse(
    execFileSync("cargo", ["metadata", "--format-version", "1"], {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 2 ** 28,
    }),
  ) as { packages: { name: string; manifest_path: string }[] };
  const crate = metadata.packages.find((entry) => entry.name === "rustel-transpiler");
  if (crate === undefined) throw new Error("cargo metadata lists no rustel-transpiler");
  const e2e = resolve(dirname(crate.manifest_path), "../runtime/tests/e2e");

  const golden = new Map<string, Golden>();
  for (const set of ["docs", "corpus", "probes"]) {
    const rows = readFileSync(join(e2e, "golden", `${set}.jsonl`), "utf8");
    for (const line of rows.split("\n")) {
      if (line.trim() === "") continue;
      const row = JSON.parse(line) as Golden;
      golden.set(row.case, row);
    }
  }

  const walk = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const path = join(dir, entry.name);
      return entry.isDirectory() ? walk(path) : entry.name.endsWith(".strudel") ? [path] : [];
    });
  const scores = join(e2e, "scores");
  return walk(scores)
    .map((path) => {
      const name = relative(scores, path).slice(0, -".strudel".length).split(sep).join("/");
      return { name, text: readFileSync(path, "utf8"), golden: golden.get(name) };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

interface Row {
  name: string;
  class: Class;
  /** The first missing name, the refusal, the error message, or the difference. */
  detail: string;
}

/** The kind of callback a refusal names, or the start of any other message. */
function refusal(message: string): string {
  const found = /(?:callback \d+: )?([^:]*?) is not supported by the binding/.exec(message);
  return found ? found[1].trim() : message.slice(0, 120);
}

/** What differs from the golden row, for a score which evaluates and differs. */
function difference(outcome: { count: number; context: number }, golden: Golden): string {
  if (outcome.count !== golden.haps) return `haps ${outcome.count} against ${golden.haps}`;
  if (outcome.context !== golden.ctx) return `context ${outcome.context} against ${golden.ctx}`;
  return "same haps and context, other digest";
}

/** A message without the folder of the machine which made the message. */
function tidy(text: string): string {
  return text.replace(/[^\s:'"]*\/(crates\/)/g, "$1").replace(/\s+/g, " ");
}

function classify(name: string, outcome: Outcome, golden: Golden | undefined): Row {
  if (!outcome.ok) {
    if (outcome.missing !== undefined) return { name, class: "missing", detail: outcome.missing };
    if (outcome.message.includes(REFUSAL)) {
      return { name, class: "unsupported", detail: refusal(outcome.message) };
    }
    return {
      name,
      class: "error",
      detail: tidy(`${outcome.error}: ${outcome.message}`).slice(0, 200),
    };
  }
  if (golden === undefined) return { name, class: "error", detail: "no golden row" };
  if (
    outcome.count === golden.haps &&
    outcome.sha256 === golden.haps_sha256 &&
    outcome.context === golden.ctx
  ) {
    return { name, class: "pass", detail: "" };
  }
  // An error inside a score function is swallowed by the engine in a query. A
  // name the function lacks is a missing name, any other throw is an error.
  if (outcome.callbackThrow !== "") {
    const lacking = /^ReferenceError: ([\w$]+) is not defined$/.exec(outcome.callbackThrow);
    if (lacking) return { name, class: "missing", detail: lacking[1] };
    return {
      name,
      class: "error",
      detail: tidy(`callback: ${outcome.callbackThrow}`).slice(0, 200),
    };
  }
  if (outcome.thrown !== "") {
    if (outcome.thrown.includes(REFUSAL)) {
      return { name, class: "unsupported", detail: refusal(outcome.thrown) };
    }
    return { name, class: "error", detail: tidy(`query: ${outcome.thrown}`).slice(0, 200) };
  }
  return { name, class: "wrong", detail: difference(outcome, golden) };
}

interface Pool {
  run: (job: Job) => Promise<Outcome>;
  close: () => Promise<void>;
}

function pool(module: WebAssembly.Module, size: number, timeout: number, locked: boolean): Pool {
  interface Slot {
    worker: Worker;
    served: number;
  }
  const spawn = (): Slot => ({
    worker: new Worker(new URL("./worker.ts", import.meta.url), {
      workerData: { module, locked },
      resourceLimits: { stackSizeMb: 64, maxOldGenerationSizeMb: 4096 },
    }),
    served: 0,
  });
  const free: Slot[] = Array.from({ length: size }, spawn);
  const waiting: ((slot: Slot) => void)[] = [];
  const take = (): Promise<Slot> => {
    const slot = free.pop();
    return slot ? Promise.resolve(slot) : new Promise((resolve) => waiting.push(resolve));
  };
  const give = (slot: Slot): void => {
    const next = waiting.shift();
    if (next) next(slot);
    else free.push(slot);
  };

  return {
    async run(job) {
      let slot = await take();
      const outcome = await new Promise<Outcome>((resolve) => {
        const started = performance.now();
        const done = (outcome: Outcome) => {
          clearTimeout(timer);
          slot.worker.off("message", onMessage);
          slot.worker.off("error", onError);
          resolve(outcome);
        };
        const failed = (message: string, error: string) =>
          done({ ok: false, error, message, missing: undefined, ms: performance.now() - started });
        const onMessage = (reply: { outcome: Outcome }) => done(reply.outcome);
        const onError = (error: Error) => {
          slot = spawn();
          failed(String(error.message ?? error), "WorkerError");
        };
        const timer = setTimeout(() => {
          void slot.worker.terminate();
          slot = spawn();
          failed(`time limit of ${timeout} ms`, "Timeout");
        }, timeout);
        slot.worker.on("message", onMessage);
        slot.worker.on("error", onError);
        slot.worker.postMessage(job);
      });
      slot.served += 1;
      if (slot.served >= MAX_SERVED) {
        void slot.worker.terminate();
        slot = spawn();
      }
      give(slot);
      return outcome;
    },
    async close() {
      await Promise.all([...free].map((slot) => slot.worker.terminate()));
    },
  };
}

interface Expected {
  class: Class;
  reason: string;
}

/** Runs every score and returns one row for each, in the order of the scores. */
async function runScores(scores: Score[], options: Settings): Promise<Row[]> {
  const transpilerModule = await compile(readFileSync(options.transpilerWasm));
  const transpiler = createTranspiler(transpilerModule);
  const workers = pool(
    await compile(readFileSync(options.engineWasm)),
    options.workers,
    options.timeout,
    options.lockdown,
  );
  const rows: Row[] = new Array(scores.length);
  let next = 0;
  const lane = async (): Promise<void> => {
    for (;;) {
      const at = next++;
      if (at >= scores.length) return;
      const { name, text, golden } = scores[at];
      let outcome: Outcome;
      try {
        const result = transpiler.run(text);
        if (result.diagnostics.length > 0) {
          const first = result.diagnostics[0];
          outcome = {
            ok: false,
            error: "TranspileError",
            message: first.message,
            missing: undefined,
            ms: 0,
          };
        } else {
          const job = {
            name,
            body: result.body,
            awaits: result.awaits,
            hints: result.registrations,
          };
          outcome = await workers.run(job);
        }
      } catch (error) {
        // A trap ends the instance. The transpiler makes a new one for the next score.
        const message = String((error as Error | undefined)?.message ?? error);
        outcome = { ok: false, error: "TranspilerTrap", message, missing: undefined, ms: 0 };
      }
      rows[at] = classify(name, outcome, golden);
    }
  };
  await Promise.all(Array.from({ length: options.workers }, lane));
  await workers.close();
  return rows;
}

/** The differences between the non-pass scores of the run and the file. Empty when equal. */
function compare(rows: Row[], expected: Record<string, Expected>): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    if (!CLASSES.includes(row.class)) problems.push(`${row.name}: no class`);
    if (row.class === "pass") continue;
    seen.add(row.name);
    const listed = expected[row.name];
    if (listed === undefined) {
      problems.push(`new failure: ${row.name} is ${row.class}: ${row.detail}`);
    } else if (listed.class !== row.class) {
      problems.push(`${row.name} is ${row.class} and the list says ${listed.class}: ${row.detail}`);
    }
  }
  for (const name of Object.keys(expected)) {
    if (!seen.has(name)) problems.push(`${name} passes and is still listed`);
  }
  return problems;
}

async function main(): Promise<void> {
  const options = settings(process.argv.slice(2));
  const scores = scoresOfTheEngine().filter((score) => score.name.startsWith(options.only));
  if (scores.length === 0) throw new Error("no score to run");
  const rows = await runScores(scores, options);
  if (options.out !== undefined) {
    writeFileSync(options.out, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
  }
  const counts = CLASSES.map((name) => rows.filter((row) => row.class === name).length);
  const listed = JSON.parse(readFileSync(join(import.meta.dirname, "expected.json"), "utf8"));
  // A partial run checks only the scores of the run.
  const expected = Object.fromEntries(
    Object.entries(listed as Record<string, Expected>).filter(([name]) =>
      name.startsWith(options.only),
    ),
  );
  const problems = compare(rows, expected);
  const split = CLASSES.slice(1)
    .map((name, at) => `${counts[at + 1]} ${name}`)
    .join(", ");
  console.log(
    `conformance: ${rows.length} scores, ${counts[0]} pass, ${split}, ${problems.length} unexpected`,
  );
  if (problems.length > 0) {
    console.error(problems.slice(0, MAX_PROBLEMS).join("\n"));
    if (problems.length > MAX_PROBLEMS) console.error(`and ${problems.length - MAX_PROBLEMS} more`);
    process.exitCode = 1;
  }
}

await main();
