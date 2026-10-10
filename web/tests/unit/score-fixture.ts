// The fixture of the score tests: one compiled module, a new instance for each
// test. The tests need the built module: run `scripts/wasm-build engine` first.

import { readFileSync } from "node:fs";
import type { Binding } from "../../src/engine/score/binding.ts";
import { compile, openScoreHost, type ScoreHost } from "../../src/engine/score/score.ts";

const MODULE = new URL(
  "../../../target/wasm32-unknown-unknown/release/rustel_web_engine.wasm",
  import.meta.url,
);
const compiled = compile(readFileSync(MODULE));

/** Any name of the score surface: callable, and every member is the same. */
export interface Dynamic {
  (...args: unknown[]): Dynamic;
  [name: string]: Dynamic;
}
export type Pattern = Dynamic;
export type Scope = Record<string, Dynamic>;

export interface Fixture {
  host: ScoreHost;
  binding: Binding;
  scope: Scope;
  /** The sorted hap lines of cycles 0 to 2, as text. */
  lines: (pattern: unknown) => string;
  /** The query itself, with the message of a throw. */
  query: (pattern: unknown) => ReturnType<Binding["query"]>;
}

export async function open(): Promise<Fixture> {
  const host = await openScoreHost(await compiled);
  const binding = host.binding;
  const query = (pattern: unknown) => binding.query(pattern as never, 0, 2);
  return {
    host,
    binding,
    scope: host.surface.scope as Scope,
    lines: (pattern) => new TextDecoder().decode(query(pattern).bytes),
    query,
  };
}
