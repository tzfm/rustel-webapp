// The tape and the handles of patterns.

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { open, type Pattern } from "./score-fixture.ts";

describe("the tape", () => {
  test("every tag comes back as sent", async () => {
    const { binding, scope, lines } = await open();
    const same = (value: unknown) => assert.deepEqual(binding.echo([value]), [value]);
    same(undefined);
    same(null);
    same(true);
    same(false);
    same(1.5);
    same(Infinity);
    same("");
    same("bd*4 \u{1F941} \u00e9");
    same([1, [2, ["three"]], {}]);
    same({ s: "bd", n: { deep: [1, 2] }, "": 0 });
    assert.ok(Object.is((binding.echo([-0]) as number[])[0], -0));
    assert.ok(Number.isNaN((binding.echo([NaN]) as number[])[0]));
    // A member named __proto__ is data and not a prototype.
    const wild = JSON.parse('{"__proto__": 1, "a": 2}');
    const back = (binding.echo([wild]) as object[])[0];
    assert.deepEqual(Object.keys(back), ["__proto__", "a"]);
    assert.equal(Object.getPrototypeOf(back), Object.prototype);
    // A pattern comes back as a pattern with a handle of its own.
    const pattern = scope.fast(2, scope.m("a b", 0));
    const [echoed] = binding.echo([pattern]) as { handle: number }[];
    assert.notEqual(echoed.handle, (pattern as unknown as { handle: number }).handle);
    assert.equal(lines(echoed), lines(pattern));
    // A function comes back as the same function, tagged or not.
    const untouched = () => 1;
    assert.equal((binding.echo([untouched]) as unknown[])[0], untouched);
    const tagged = scope.fast(2);
    assert.equal((binding.echo([tagged, 7]) as unknown[])[0], tagged);
    assert.equal((binding.echo([tagged, 7]) as unknown[])[1], 7);
  });

  test("a string crosses once and is known after", async () => {
    const { binding } = await open();
    const before = binding.tape.atomCount();
    binding.echo(["a unique string", "a unique string", { "a unique string": 1 }]);
    assert.equal(binding.tape.atomCount() - before, 1);
  });

  test("a value past the limits fails", async () => {
    const { binding } = await open();
    let deep: unknown = 1;
    for (let level = 0; level < 100; level += 1) deep = [deep];
    assert.throws(() => binding.echo([deep]), RangeError);
    assert.throws(
      () => binding.echo([Array.from({ length: binding.tape.bytes / 16 }, () => 1)]),
      RangeError,
    );
    assert.throws(() => binding.echo([Symbol("x")]), TypeError);
  });
});

describe("pattern handles", () => {
  test("an explicit free gives the handle back", async () => {
    const { binding, scope } = await open();
    const base = binding.live();
    const pattern = scope.fast(2, scope.m("a b", 0)) as unknown as {
      free: () => void;
      handle: number;
    };
    assert.equal(binding.live(), base + 2);
    pattern.free();
    assert.equal(binding.live(), base + 1);
    pattern.free();
    assert.equal(binding.live(), base + 1);
  });

  test("a freed pattern cannot be used", async () => {
    const { binding, scope } = await open();
    const pattern = scope.m("a", 0) as unknown as { free: () => void };
    pattern.free();
    assert.throws(() => binding.query(pattern as never, 0, 1), /live pattern/);
    assert.throws(() => (pattern as unknown as Pattern).fast(2), /live pattern/);
  });

  test("a reused slot does not answer to a stale handle", async () => {
    const { scope } = await open();
    const first = scope.m("a", 0) as unknown as { free: () => void; handle: number };
    const stale = first.handle;
    first.free();
    const second = scope.m("b", 0) as unknown as { handle: number };
    assert.notEqual(second.handle, stale);
    // The same slot, another generation.
    assert.equal(second.handle & 0xffffff, stale & 0xffffff);
  });
});
