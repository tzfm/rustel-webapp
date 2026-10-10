// The transpiler module in the Worker: score text in, the text to evaluate and
// the diagnostics out. The exports are those of `crates/transpiler`.
//
// An exception out of an export is a trap, and a trap leaves the state of the
// module half written. The instance goes away and the score which trapped is
// refused. The next score meets a new instance made from the compiled module.

import type { Hints } from "./score/score.ts";

// Made when the module loads. The lockdown (`score/lockdown.ts`) removes these
// names from the global object before a score runs, and the glue must not look
// up a name on the global object after the lockdown.
const Wasm = WebAssembly;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** What `tp_transpile` returns for bytes which are no text. */
const FAILED = 0xffffffff;
/** The 64-bit answer of `tp_original_position` when the line map has none. */
const NO_POSITION = 0xffffffffffffffffn;

export interface Diagnostic {
  message: string;
  /** UTF-8 byte offset in the score text, or null. */
  offset: number | null;
}

/** The part of the transpiler result the Worker reads. */
export interface Transpiled {
  /** The text every position of the result refers to. */
  output: string;
  /** The text to evaluate: the output with the final return. Empty with diagnostics. */
  body: string;
  /** True when the output holds an `await`. */
  awaits: boolean;
  /** Empty when the score runs. */
  diagnostics: Diagnostic[];
  registrations: Hints;
}

/** A place in a text. Both numbers count from 0. The column counts UTF-16 code units. */
export interface Place {
  line: number;
  column: number;
}

export interface Transpiler {
  /** Transpiles one score. Throws when the module trapped. */
  run(text: string): Transpiled;
  /** The place in the score text of a place in `output`, or undefined. */
  original(line: number, column: number): Place | undefined;
}

/** The exports of the module. */
export interface Exports {
  memory: WebAssembly.Memory;
  tp_scratch: (bytes: number) => number;
  tp_transpile: (bytes: number) => number;
  tp_result: () => number;
  tp_original_position: (line: number, column: number) => bigint;
}

function instantiate(module: WebAssembly.Module): Exports {
  return new Wasm.Instance(module, {}).exports as unknown as Exports;
}

/** `make` gives a new instance. The tests replace the default to force a trap. */
export function createTranspiler(
  module: WebAssembly.Module,
  make: (module: WebAssembly.Module) => Exports = instantiate,
): Transpiler {
  let wasm = make(module);

  function transpile(text: string): Transpiled {
    const bytes = encoder.encode(text);
    // The memory grows during a call, so every view is made after the call.
    const scratch = wasm.tp_scratch(bytes.length);
    new Uint8Array(wasm.memory.buffer, scratch, bytes.length).set(bytes);
    const length = wasm.tp_transpile(bytes.length);
    if (length === FAILED) throw new Error("the transpiler refused the bytes");
    const json = decoder.decode(new Uint8Array(wasm.memory.buffer, wasm.tp_result(), length));
    return JSON.parse(json) as Transpiled;
  }

  return {
    run(text) {
      try {
        return transpile(text);
      } catch (error) {
        wasm = make(module);
        throw new Error(
          `The transpiler stopped on this score (${String((error as Error | undefined)?.message ?? error)}).`,
        );
      }
    },
    original(line, column) {
      const packed = BigInt.asUintN(64, wasm.tp_original_position(line, column));
      if (packed === NO_POSITION) return undefined;
      return { line: Number(packed >> 32n), column: Number(packed & 0xffffffffn) };
    },
  };
}
