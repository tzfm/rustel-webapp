// Evaluate a transpiled score against one instance of the module.
//
// The engine runtime wraps the score text in a function, runs the function,
// and reads the pattern the function returns (`wrap_score_scope`, `execute_score` in
// `crates/jsruntime/src/runtime/evaluation.rs`). A score which awaits runs in
// an async function and the engine pumps jobs until the promise settles. This
// file does the same with the engine of the host.

import { type Binding, compile, openBinding, type PatternObject } from "./binding.ts";
import { installNames, type ScoreNames } from "./names.ts";
import { installQuery } from "./query.ts";
import { installRegister } from "./register.ts";
import { installSurface, type Surface } from "./surface.ts";

export { compile };

/** What the transpiler knows of the source before the run. */
export interface Hints {
  /** The last expression of the score is a call of `register`. */
  final_expression_is_registration: boolean;
}

export interface ScoreHost {
  binding: Binding;
  surface: Surface;
  names: ScoreNames;
  /**
   * Run the body of a transpiled score: the `body` field of the transpiler
   * result, which ends in `return`. A result with diagnostics has no body and
   * is not run. Resolves to the pattern the score names.
   */
  evaluate: (body: string, awaits: boolean, hints?: Hints) => Promise<PatternObject>;
}

/** Names a function does not accept as parameters. */
const RESERVED = new Set([
  "arguments",
  "await",
  "break",
  "case",
  "catch",
  "class",
  "const",
  "continue",
  "debugger",
  "default",
  "delete",
  "do",
  "else",
  "enum",
  "eval",
  "export",
  "extends",
  "false",
  "finally",
  "for",
  "function",
  "if",
  "implements",
  "import",
  "in",
  "instanceof",
  "interface",
  "let",
  "new",
  "null",
  "package",
  "private",
  "protected",
  "public",
  "return",
  "static",
  "super",
  "switch",
  "this",
  "throw",
  "true",
  "try",
  "typeof",
  "var",
  "void",
  "while",
  "with",
  "yield",
]);

function isParameter(name: string): boolean {
  return /^[A-Za-z_$][\w$]*$/.test(name) && !RESERVED.has(name);
}

/** Lines the wrapper puts before the body: the function line and the directive. */
export const WRAPPER_LINES = 2;

/** A console which keeps the output of a score out of the host. */
const quietConsole = { log() {}, warn() {}, error() {}, info() {}, debug() {} };

export async function openScoreHost(module: WebAssembly.Module): Promise<ScoreHost> {
  const binding = await openBinding(module);
  const surface = installSurface(binding);
  const names = installNames(surface);
  const registrations = installRegister(binding, surface);
  installQuery(binding, surface);
  surface.scope.register = registrations.register;
  const scope: Record<string, unknown> = { ...surface.scope, console: quietConsole };
  const parameters = Object.keys(scope).filter(isParameter);
  const values = parameters.map((name) => scope[name]);

  async function evaluate(body: string, awaits: boolean, hints?: Hints): Promise<PatternObject> {
    registrations.restore();
    names.reset();
    binding.beginScore();
    // The score text runs inside a function of its own, so a declaration of
    // the score shadows a name of the surface. The directive makes the text
    // strict, as the engine runs the text.
    // `WRAPPER_LINES` counts the two lines before the body.
    const wrapped = awaits
      ? `return (async function () {\n"use strict";\n${body}\n})();`
      : `return (function () {\n"use strict";\n${body}\n})();`;
    const run = new Function(...parameters, wrapped) as (...values: unknown[]) => unknown;
    const returned = await run(...values);
    const result = names.finish(returned);
    if (result instanceof binding.Pattern) return result;
    // A score with nothing to play yet is silence: an empty score, and a score
    // which ends in a registration, as the engine session installs the score. Any
    // other value is a mistake of the score.
    if (result === undefined || hints?.final_expression_is_registration)
      return surface.scope.silence as PatternObject;
    throw new TypeError("the score does not end in a pattern");
  }

  return { binding, surface, names, evaluate };
}
