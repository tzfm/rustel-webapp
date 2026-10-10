// The transpiler module in Node: score text in, the result object out. The
// exports are those of `crates/transpiler`. The module keeps its result
// between calls, so this class reads the result at once.

import type { Hints } from "../../src/engine/score/score.ts";

/** What `tp_transpile` returns for bytes which are no text. */
const FAILED = 0xffffffff;

export interface Transpiled {
  /** The text every position of the result refers to. */
  output: string;
  /** The text to evaluate: the output with the final return. Empty with diagnostics. */
  body: string;
  /** True when the output holds an `await`. */
  awaits: boolean;
  /** Empty when the score runs. A score with diagnostics is not runnable and has no body. */
  diagnostics: { message: string; offset: number | null }[];
  registrations: Hints;
}

interface Exports {
  memory: WebAssembly.Memory;
  tp_scratch: (bytes: number) => number;
  tp_transpile: (bytes: number) => number;
  tp_result: () => number;
}

export class Transpiler {
  private readonly wasm: Exports;

  constructor(module: WebAssembly.Module) {
    this.wasm = new WebAssembly.Instance(module, {}).exports as unknown as Exports;
  }

  /** Transpiles one score. A trap ends the instance: the caller makes a new one. */
  run(text: string): Transpiled {
    const bytes = new TextEncoder().encode(text);
    const { memory, tp_scratch, tp_transpile, tp_result } = this.wasm;
    // The memory grows during a call, so every view is made after the call.
    const scratch = tp_scratch(bytes.length);
    new Uint8Array(memory.buffer, scratch, bytes.length).set(bytes);
    const length = tp_transpile(bytes.length);
    if (length === FAILED) throw new Error("the transpiler refused the bytes");
    const json = new TextDecoder().decode(new Uint8Array(memory.buffer, tp_result(), length));
    return JSON.parse(json) as Transpiled;
  }
}
