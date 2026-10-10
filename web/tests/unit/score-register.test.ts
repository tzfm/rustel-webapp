// `register`: the names a score adds.

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { type Dynamic, open, type Pattern } from "./score-fixture.ts";

describe("a registered name", () => {
  test("is a method and a curried function, and a later call replaces the name", async () => {
    const { scope, lines } = await open();
    const base = () => scope.s(scope.m("bd sd", 0)) as unknown as Pattern;
    const twice = scope.register("twice", ((n: unknown, pat: Pattern) =>
      pat.fast(n)) as never) as unknown as Dynamic;
    const method = lines(base().twice(2));
    assert.equal(lines(twice(2)(base())), method);
    assert.equal(lines(twice(2, base())), method);
    assert.equal(lines(base().twice(scope.m("2", 0))), method);
    assert.equal(lines(base().fast(2)), method);
    // The same name again takes the new function.
    scope.register("twice", ((_n: unknown, pat: Pattern) => pat.rev()) as never);
    assert.notEqual(lines(base().twice(2)), method);
    // A name of the engine is refused, and a name as a pattern too.
    assert.throws(() => scope.register("fast", (() => 1) as never), {
      message:
        "register('fast') would replace the existing built-in 'fast'. Pick a different name.",
    });
    assert.throws(
      () => scope.register(scope.m("x", 0), (() => 1) as never),
      /try using single quotes/,
    );
  });

  test("with a patterned argument runs when the pattern is queried", async () => {
    const { scope, binding, lines } = await open();
    const base = () => scope.s(scope.m("bd sd", 0)) as unknown as Pattern;
    let calls = 0;
    scope.register("slowly", ((n: unknown, pat: Pattern) => {
      calls += 1;
      return pat.slow(n);
    }) as never);
    const mapped = base().slowly(scope.m("<1 2>", 0));
    assert.equal(calls, 0);
    assert.ok(lines(mapped).length > 0);
    assert.ok(calls > 0);
    assert.ok(binding.crossings() > 0);
  });

  test("whose body throws fails the call, or empties the query", async () => {
    const { scope, binding, query } = await open();
    const base = () => scope.s(scope.m("bd sd", 0)) as unknown as Pattern;
    scope.register("boom", ((_n: unknown, _pat: Pattern) => {
      throw new Error("boom in a body");
    }) as never);
    // All arguments hold one value: the body runs now and the error is the call's.
    assert.throws(() => base().boom(2), { message: "boom in a body" });
    // A patterned argument: the body runs in the query, which has no haps.
    const result = query(base().boom(scope.m("<1 2>", 0)));
    assert.equal(result.count, 0);
    assert.match(binding.firstThrow() ?? "", /boom in a body/);
  });

  test("a score which ends in a registration is silence", async () => {
    const { host, lines } = await open();
    const hints = { final_expression_is_registration: true };
    const silent = await host.evaluate("register('quiet', (pat) => pat)", false, hints);
    assert.equal(lines(silent), "");
    await assert.rejects(host.evaluate("return 42;", false), /does not end in a pattern/);
  });
});
