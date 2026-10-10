// The evaluator of the Worker: one score text in, one outcome out. The tests use
// the real transpiler module and the real engine module, and a player which
// records what the evaluator asks of the engine. Firefox gives the position of an
// exception on the error object, and Node does not: the browser test covers
// the exception of a real score, and these tests feed the evaluator the numbers.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import {
  createEvaluator,
  errorPlace,
  type Outcome,
  type Player,
  placeOfByte,
} from "../../src/engine/evaluate.ts";
import { createTranspiler, type Exports } from "../../src/engine/transpiler.ts";
import { open } from "./score-fixture.ts";

const TRANSPILER = new URL(
  "../../../target/wasm32-unknown-unknown/release/rustel_web_transpiler.wasm",
  import.meta.url,
);
const module = new WebAssembly.Module(readFileSync(TRANSPILER));
const FRAME = 4096;

/** The evaluator on a new host, and the calls made on the engine. */
async function setup(make?: (module: WebAssembly.Module) => Exports) {
  const { host } = await open();
  const calls: string[] = [];
  const player: Player = {
    setCps: (cps, frame) => calls.push(`cps ${cps} at ${frame}`),
    setScore: (_handle, frame) => {
      calls.push(`score at ${frame}`);
      return null;
    },
  };
  const transpiler = createTranspiler(module, make);
  const evaluate = createEvaluator({ transpiler, host, player, frame: () => FRAME });
  return { evaluate, calls, transpiler };
}

function refusal(outcome: Outcome) {
  assert.equal(outcome.ok, false);
  return outcome as Extract<Outcome, { ok: false }>;
}

describe("a score text with a diagnostic", () => {
  test("is refused at the first diagnostic, with its place in the score text, and runs nothing", async () => {
    const { evaluate, calls } = await setup();
    // Byte offsets count UTF-8: the é takes 2 bytes, and the place counts UTF-16 units.
    const outcome = refusal(await evaluate('const é = 1;\nnote("c3 e3"'));
    assert.match(outcome.error, /Expected `\)`/);
    assert.deepEqual(outcome.position, { line: 2, column: 13 });
    assert.deepEqual(calls, []);
  });

  test("counts a byte offset in UTF-16 units", () => {
    assert.deepEqual(placeOfByte("aé\n😀x", 0), { line: 0, column: 0 });
    assert.deepEqual(placeOfByte("aé\n😀x", 3), { line: 0, column: 2 });
    assert.deepEqual(placeOfByte("aé\n😀x", 8), { line: 1, column: 2 });
    assert.deepEqual(placeOfByte("aé\n😀x", 99), { line: 1, column: 3 });
  });
});

describe("the position of an exception", () => {
  // Firefox counts lines and columns in the source of the Function from 1. The
  // source holds 2 lines of the Function constructor and 2 of the wrapper
  // before the body.
  const fromFunction = (bodyLine: number, bodyColumn: number) => ({
    fileName: "worker.js line 1 > Function",
    lineNumber: bodyLine + 5,
    columnNumber: bodyColumn + 1,
  });

  test("goes from the Function, through the final return, to the score text", async () => {
    const { transpiler } = await setup();
    const text = 'setcps(1)\nnote("c3 e3")';
    const transpiled = transpiler.run(text);
    assert.equal(transpiled.body, "setcps(1);\nreturn note(m('c3 e3', 15));");
    const place = (line: number, column: number) =>
      errorPlace(fromFunction(line, column), transpiled, transpiler);
    assert.deepEqual(place(0, 0), { line: 0, column: 0 });
    // `note` follows the 7 characters of `return `.
    assert.deepEqual(place(1, 7), { line: 1, column: 0 });
    // Inside the mini-notation string, the map goes by token.
    assert.deepEqual(place(1, 14), { line: 1, column: 7 });
    // Inside the added return, the place is the start of the expression.
    assert.deepEqual(place(1, 3), { line: 1, column: 0 });
    // A line the body does not have.
    assert.equal(place(9, 0), undefined);
  });

  test("is undefined for an error with no place, or from a file of the glue", async () => {
    const { transpiler } = await setup();
    const transpiled = transpiler.run("note('c3')");
    assert.equal(errorPlace(new Error("x"), transpiled, transpiler), undefined);
    assert.equal(errorPlace(null, transpiled, transpiler), undefined);
    const glue = { ...fromFunction(0, 0), fileName: "worker.js" };
    assert.equal(errorPlace(glue, transpiled, transpiler), undefined);
  });

  test("is added to the refusal of a score which throws", async () => {
    const { evaluate, calls } = await setup();
    const fake =
      "Object.assign(new Error('boom'), { fileName: 'w.js line 1 > Function', lineNumber: 7, columnNumber: 7 })";
    const outcome = refusal(await evaluate(`note('c3');\nnote('e3');\nthrow ${fake};`));
    assert.equal(outcome.error, "boom");
    // Function line 7 is body line 2, which is score line 3. Column 7 is index 6.
    assert.deepEqual(outcome.position, { line: 3, column: 7 });
    assert.deepEqual(calls, []);
    // A throw of a bare value has a message and no place.
    assert.deepEqual(refusal(await evaluate("throw 'bare';")), { ok: false, error: "bare" });
  });
});

describe("the tempo of a score", () => {
  test("reaches the engine before the pattern, with the current frame", async () => {
    const { evaluate, calls } = await setup();
    assert.deepEqual(await evaluate("setcps(1.5)\nnote('c3')"), { ok: true });
    assert.deepEqual(calls, [`cps 1.5 at ${FRAME}`, `score at ${FRAME}`]);
  });

  test("takes every spelling, and cycles per minute are divided by 60", async () => {
    const { evaluate, calls } = await setup();
    for (const [call, cps] of [
      ["setCps(2)", 2],
      ["setcps(0.25)", 0.25],
      ["cps(3)", 3],
      ["setCpm(90)", 1.5],
      ["setcpm(30)", 0.5],
    ] as const) {
      calls.length = 0;
      await evaluate(`${call}\nnote('c3')`);
      assert.deepEqual(calls, [`cps ${cps} at ${FRAME}`, `score at ${FRAME}`], call);
    }
  });

  test("is left alone when the score sets none, or when the score fails", async () => {
    const { evaluate, calls } = await setup();
    await evaluate("note('c3')");
    assert.deepEqual(calls, [`score at ${FRAME}`]);
    calls.length = 0;
    refusal(await evaluate("setcps(2)\nthrow new Error('late');"));
    refusal(await evaluate("setcps(-1)\nnote('c3')"));
    assert.deepEqual(calls, []);
  });
});

describe("the transpiler instance", () => {
  test("is dropped after a trap, and the next score runs on a new instance", async () => {
    let made = 0;
    const { evaluate, calls } = await setup((module) => {
      const exports = new WebAssembly.Instance(module, {}).exports as unknown as Exports;
      made += 1;
      // A request the memory cannot hold traps inside the module.
      return made === 1
        ? { ...exports, tp_scratch: () => exports.tp_scratch(0xfffffff0) }
        : exports;
    });
    const outcome = refusal(await evaluate("note('c3')"));
    assert.match(outcome.error, /^The transpiler stopped on this score/);
    assert.equal(outcome.position, undefined);
    assert.equal(made, 2);
    assert.deepEqual(await evaluate("note('c3')"), { ok: true });
    assert.deepEqual(calls, [`score at ${FRAME}`]);
  });
});
