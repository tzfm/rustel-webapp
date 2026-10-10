// The objects of the pattern language and the callbacks which take them.

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  FractionFunction as fraction,
  Hap,
  type State,
  TimeSpan,
} from "../../src/engine/score/objects.ts";
import { open, type Pattern } from "./score-fixture.ts";

describe("the objects of the pattern language", () => {
  test("a fraction crosses exact, past 2^53 and past 64 bits", async () => {
    const { binding, scope } = await open();
    assert.equal(scope.Fraction, fraction);
    assert.equal(scope.TimeSpan, TimeSpan);
    for (const [n, d] of [
      [2n ** 60n + 1n, 3n],
      [-(2n ** 62n), 7n],
      [2n ** 100n + 5n, 2n ** 70n + 1n],
      [1n, 3n],
    ]) {
      const [back] = binding.echo([fraction(n, d)]) as ReturnType<typeof fraction>[];
      const expected = fraction(n, d);
      assert.deepEqual([back.s, back.n, back.d], [expected.s, expected.n, expected.d]);
    }
    // A number reads as the nearest simple fraction, and a string as written.
    assert.equal(fraction(1 / 3).d, 3n);
    assert.equal(fraction("0.(3)").d, 3n);
    assert.equal(fraction("1 1/2").n, 3n);
    assert.throws(() => fraction(1, 0), { message: "Division by Zero" });
    assert.throws(() => fraction(1.5, 2), { message: "Parameters must be integer" });
  });

  test("fraction arithmetic stays exact past 2^53", () => {
    const big = fraction(2n ** 60n + 1n);
    assert.equal(big.add(1).n, 2n ** 60n + 2n);
    assert.equal(big.mul(big).n, (2n ** 60n + 1n) ** 2n);
    assert.equal(big.sub(2n ** 60n).n, 1n);
    assert.equal(big.div(3).d, 3n);
    assert.equal(big.mod(7).n, (2n ** 60n + 1n) % 7n);
    assert.equal(big.neg().s, -1n);
    assert.equal(big.neg().abs().s, 1n);
    const half = fraction(7, 2);
    assert.deepEqual([half.floor().n, half.ceil().n, half.round().n], [3n, 4n, 4n]);
    assert.equal(fraction(-7, 2).round().show(), "-3/1");
    assert.equal(fraction(7, 3).cyclePos().show(), "1/3");
    assert.ok(half.eq(3.5) && half.ne(3) && half.equals("7/2"));
  });

  test("span and hap methods", () => {
    const span = new TimeSpan(1, 3);
    assert.deepEqual(
      span.spanCycles.map((cycle) => cycle.show()),
      ["1/1 → 2/1", "2/1 → 3/1"],
    );
    assert.equal(span.duration.valueOf(), 2);
    assert.equal(span.withTime((time) => time.mul(2)).show(), "2/1 → 6/1");
    assert.equal(span.intersection(new TimeSpan(0, 2))?.show(), "1/1 → 2/1");
    assert.equal(new TimeSpan(0, 1).intersection(new TimeSpan(1, 2)), undefined);
    assert.throws(
      () => new TimeSpan(0, 1).intersection_e(new TimeSpan(2, 3)),
      (thrown) => thrown === "TimeSpans do not intersect",
    );
    assert.ok(span.equals(new TimeSpan(1, 3)));
    const hap = new Hap(new TimeSpan(0, 1), new TimeSpan(0.5, 1), { n: 1 });
    assert.equal(hap.show(), '[ 0/1 ⇜ (1/2 → 1/1) | {"n":1} ]');
    assert.equal(hap.show(true), "[ 0/1 ⇜ (1/2 → 1/1) | n:1 ]");
    assert.equal(hap.hasOnset(), false);
    assert.equal(hap.duration.valueOf(), 1);
    assert.equal(hap.wholeOrPart().show(), "0/1 → 1/1");
    assert.equal(new Hap(undefined, new TimeSpan(0, 1), 5).wholeOrPart().show(), "0/1 → 1/1");
    assert.equal(
      hap.withSpan((cycle) => cycle.withTime((time) => time.add(1))).part.begin.valueOf(),
      1.5,
    );
    assert.ok(hap.equals(new Hap(new TimeSpan(0, 1), new TimeSpan(0.5, 1), hap.value)));
    assert.ok(!hap.spanEquals(new Hap(new TimeSpan(0, 2), new TimeSpan(0.5, 1), 1)));
  });

  test("a fraction which reaches a registry name is its number", async () => {
    const { scope, lines } = await open();
    const base = () => scope.s(scope.m("bd sd", 0)) as unknown as Pattern;
    assert.equal(lines(base().fast(fraction(1, 3))), lines(base().fast(1 / 3)));
  });

  test("a hap is read inside a predicate", async () => {
    const { scope, lines } = await open();
    const seen: string[] = [];
    const base = scope.s(scope.m("hh oh", 0)) as unknown as Pattern;
    const kept = base.filter(((hap: Hap) => {
      const begin = hap.whole?.begin.valueOf() ?? Number.NaN;
      seen.push(`${begin} ${hap.hasOnset()} ${(hap.context.locations as unknown[]).length}`);
      return begin % 1 >= 0.5;
    }) as never);
    assert.match(lines(kept), /s:oh/);
    assert.doesNotMatch(lines(kept), /s:hh/);
    assert.ok(seen.some((line) => line.startsWith("0.5 true 1")));
  });

  test("a time predicate gets the time as a fraction", async () => {
    const { scope, lines } = await open();
    const base = scope.s(scope.m("a*4", 0)) as unknown as Pattern;
    const kept = base.filterWhen(
      ((time: ReturnType<typeof fraction>) => time.compare(1) < 0) as never,
    );
    assert.equal(lines(kept).trim().split("\n").length, 4 * 1);
  });

  test("a custom query returns haps", async () => {
    const { scope, lines, binding } = await open();
    const PatternClass = scope.Pattern as unknown as new (
      query: (state: State) => unknown[],
      steps?: unknown,
    ) => object;
    // A real hap with an extended whole, and the compact shape.
    const custom = new PatternClass((state) => {
      const sam = state.span.begin.sam();
      return [
        new Hap(
          new TimeSpan(sam, sam.add(1)),
          state.span,
          { n: 7 },
          { locations: [{ start: 1, end: 2 }] },
        ),
        { begin: 0, end: 1, value: { n: 8 } },
      ];
    }, 1);
    const query = binding.query(custom as never, 0, 1);
    assert.equal(query.count, 2);
    assert.match(lines(custom), /n:7/);
    assert.match(lines(custom), /n:8/);
    assert.equal(query.context, 1);
    // The pattern is a pattern and takes a method.
    assert.match(lines((custom as unknown as Pattern).fast(2)), /n:7/);
    // A query which is no function is refused.
    assert.throws(
      () => new (scope.Pattern as never as new (query: unknown) => object)(7),
      /this.query is not a function/,
    );
  });

  test("queryArc and withHap work on the haps of a pattern", async () => {
    const { scope, lines } = await open();
    const base = scope.s(scope.m("a b", 0)) as unknown as Pattern & {
      queryArc: (begin: number, end: number) => Hap[];
    };
    assert.deepEqual(
      base.queryArc(0, 1).map((hap) => hap.part.begin.valueOf()),
      [0, 0.5],
    );
    const moved = base.withHap(((hap: Hap) =>
      hap.withValue((value) => ({ ...(value as object), s: "z" }))) as never);
    assert.match(lines(moved), /s:z/);
  });

  test("an indexed function runs for every index before anything else, and a throw stops the batch", async () => {
    const { scope, lines } = await open();
    const base = scope.s(scope.m("a", 0)) as unknown as Pattern;
    const log: number[] = [];
    const echoed = base.echoWith(3, 0.25, ((pattern: Pattern, index: number) => {
      log.push(index);
      return pattern.gain(index + 1);
    }) as never);
    // The batch ran at the call, every index in order.
    assert.deepEqual(log, [0, 1, 2]);
    assert.match(lines(echoed), /gain:3/);
    const stopped: number[] = [];
    assert.throws(
      () =>
        base.echoWith(3, 0.25, ((pattern: Pattern, index: number) => {
          stopped.push(index);
          if (index === 1) throw new Error("stop at one");
          return pattern;
        }) as never),
      { message: /stop at one/ },
    );
    assert.deepEqual(stopped, [0, 1]);
  });
});
