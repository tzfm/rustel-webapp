// One worker of the conformance run. A message holds the transpiled text of a
// score. The worker gives the score a fresh instance of the engine module,
// evaluates the score, queries cycles 0 to 4 and answers the measures: the
// count of haps, the sum of the context lengths and the SHA-256 over the hap
// lines. The digest is made in Node, from the bytes the module gives.
//
// Before the first score the worker applies the lockdown of the score Worker
// to its own global object. The freeze runs for real. The delete step runs
// against the global names of a Firefox Worker (`firefox-worker-names.json`,
// the names of the global object and its prototype chain, recorded in a
// Firefox 157 Worker before any lockdown). A name of the list which this Node
// worker also has, and which the allowlist lacks, is deleted. A name which only
// Node has (`process`, `Buffer`) stays, because this run needs the name and
// a browser Worker has no such name. This file uses no global name after the
// lockdown, only imports and the names of the language.
//
// This run proves real scores against frozen language objects and against the
// missing names of a browser. The run does not prove the walls of the browser:
// the site of the frame and the policy of the Worker. The browser test proves
// them.

import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { parentPort, workerData } from "node:worker_threads";
import { requireLockdown } from "../../src/engine/score/lockdown.ts";
import { type Hints, openScoreHost } from "../../src/engine/score/score.ts";
import { lockNodeThread } from "./lock-node.ts";

/** The cycles the golden rows cover: 0 to 4. */
const QUERY_CYCLES = 4;

export interface Job {
  name: string;
  body: string;
  awaits: boolean;
  hints: Hints;
}

export type Outcome =
  | {
      ok: true;
      count: number;
      context: number;
      sha256: string;
      /** The message a query threw. */
      thrown: string;
      /** The first error a score function threw. The engine swallows such an error. */
      callbackThrow: string;
      ms: number;
    }
  | {
      ok: false;
      error: string;
      message: string;
      /** The name a missing global or method points at. */
      missing: string | undefined;
      ms: number;
    };

if (parentPort === null) throw new Error("this file runs as a worker");
const port = parentPort;
const { module, locked } = workerData as { module: WebAssembly.Module; locked: boolean };
// The lockdown deletes `WebAssembly`, so this file takes the error class first.
const { RuntimeError } = WebAssembly;

if (locked) lockNodeThread();

/**
 * The name a missing global or method points at. A global is missing from the
 * scope, a method from the prototype: `squeeze` is a method, and the global of
 * the same name is missing.
 */
function missingName(message: string, scope: object, proto: object): string | undefined {
  const global = /^([A-Za-z_$][\w$]*) is not defined$/.exec(message);
  if (global && !(global[1] in scope)) return global[1];
  const method = /([A-Za-z_$][\w$]*) is not a function$/.exec(message);
  if (method && !(method[1] in proto)) return method[1];
  return undefined;
}

async function run(job: Job): Promise<Outcome> {
  if (locked) requireLockdown(globalThis);
  const started = performance.now();
  const host = await openScoreHost(module);
  try {
    const pattern = await host.evaluate(job.body, job.awaits, job.hints);
    const result = host.binding.query(pattern, 0, QUERY_CYCLES);
    return {
      ok: true,
      count: result.count,
      context: result.context,
      sha256: createHash("sha256").update(result.bytes).digest("hex"),
      thrown: result.thrown,
      callbackThrow: host.binding.firstThrow() ?? "",
      ms: performance.now() - started,
    };
  } catch (error) {
    const failure = error as Error | undefined;
    let message = String(failure?.message ?? error);
    // A trap is a panic of the module. The message is in its error cell.
    if (failure instanceof RuntimeError) {
      message = `${message}: ${host.binding.lastError()}`;
    }
    return {
      ok: false,
      error: failure?.name ?? "Error",
      message,
      missing: missingName(message, host.surface.scope, host.surface.proto),
      ms: performance.now() - started,
    };
  }
}

port.on("message", (job: Job) => {
  run(job).then((outcome) => port.postMessage({ name: job.name, outcome }));
});
