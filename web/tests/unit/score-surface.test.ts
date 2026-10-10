// The names of the surface, the callbacks and the install list.

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { open, type Pattern } from "./score-fixture.ts";

describe("a registered combinator", () => {
  test("several arguments to a one-input method are a sequence", async () => {
    const { scope, lines } = await open();
    const base = () => scope.s(scope.m("bd sd", 0)) as unknown as Pattern;
    const spoken = lines(base().fast(2, 4));
    assert.equal(spoken, lines(base().fast(scope.m("2 4", 0))));
    assert.equal(spoken, lines(base().fast(scope.seq(2, 4))));
    assert.notEqual(spoken, lines(base().fast(2)));
  });

  test("a wrong count throws", async () => {
    const { scope } = await open();
    const base = () => scope.s(scope.m("bd sd", 0)) as unknown as Pattern;
    assert.throws(() => base().fast(), {
      name: "TypeError",
      message: ".fast() expects 1 inputs but got 0.",
    });
    assert.throws(() => base().every(2), {
      name: "TypeError",
      message: ".every() expects 2 inputs but got 1.",
    });
    assert.throws(() => base().rev(1), {
      name: "TypeError",
      message: ".rev() expects 0 inputs but got 1.",
    });
    assert.throws(() => base().fast(() => 1), {
      name: "TypeError",
      message: /does not accept a function/,
    });
  });

  test("the free form is curried and takes the pattern last", async () => {
    const { scope, lines } = await open();
    const base = scope.s(scope.m("bd sd", 0)) as unknown as Pattern;
    const method = lines(base.fast(2));
    assert.equal(lines(scope.fast(2)(base)), method);
    assert.equal(lines(scope.fast(2, base)), method);
    assert.equal(lines(scope.fast()(2)(base)), method);
    assert.equal(typeof scope.fast(2), "function");
  });

  test("a tagged combinator as an argument needs no callback", async () => {
    const { scope, binding, lines } = await open();
    const base = () => scope.s(scope.m("a b c", 0)) as unknown as Pattern;
    const crossings = binding.crossings();
    const reference = lines(base().every(2, scope.rev as never));
    const partial = lines(base().jux(scope.fast(2) as never));
    assert.equal(binding.crossings(), crossings);
    // The same call with a function of the score crosses and gives the same haps.
    assert.equal(lines(base().every(2, ((x: Pattern) => x.rev()) as never)), reference);
    assert.equal(lines(base().jux(((x: Pattern) => x.fast(2)) as never)), partial);
    assert.ok(binding.crossings() > crossings);
  });

  test("a bound pattern keeps the function on the callback path", async () => {
    const { scope, binding, lines } = await open();
    const base = () => scope.s(scope.m("a b c", 0)) as unknown as Pattern;
    const crossings = binding.crossings();
    const bound = lines(base().off(0.25, scope.add(scope.n(scope.m("1 2", 0))) as never));
    assert.ok(binding.crossings() > crossings);
    assert.match(bound, /n:/);
  });
});

describe("a callback", () => {
  test("an exception inside fmap is an error of the query", async () => {
    const { scope, query } = await open();
    const failing = (scope.m("1 2", 0) as unknown as Pattern).fmap(() => {
      throw new Error("boom in the score");
    });
    const result = query(failing);
    assert.equal(result.count, 0);
    assert.match(result.thrown, /boom in the score/);
  });

  test("an exception inside a pattern function is an error of the query", async () => {
    const { scope, query } = await open();
    const base = scope.s(scope.m("a b", 0)) as unknown as Pattern;
    const failing = base.every(scope.m("<1 2>", 0), (() => {
      throw new RangeError("boom in a transformer");
    }) as never);
    assert.match(query(failing).thrown, /boom in a transformer/);
  });

  test("a value function maps every hap", async () => {
    const { scope, lines } = await open();
    const mapped = (scope.m("1 2", 0) as unknown as Pattern).fmap(
      ((value: number) => value * 10) as never,
    );
    assert.match(lines(mapped), /\| 10 \]\n.*\| 20 \]/);
  });

  test("a callback which calls back into the binding", async () => {
    const { scope, binding, lines } = await open();
    const crossings = binding.crossings();
    // A value function builds a pattern with m and the module joins the result.
    const joined = (scope.m("0 1", 0) as unknown as Pattern)
      .fmap(((value: number) => scope.fast(2, scope.m(`${value} ${value}`, 0))) as never)
      .innerJoin();
    assert.equal(lines(joined).trim().split("\n").length, 2 * 2 * 2);
    // A pattern function builds with m and composes with the argument.
    const base = scope.n(scope.m("0 1", 0)) as unknown as Pattern;
    const layered = base.superimpose(((x: Pattern) =>
      x.add(scope.n(scope.m("10 20", 0)))) as never);
    assert.match(lines(layered), /n:10/);
    assert.ok(binding.crossings() > crossings);
  });

  test("a callback nests through a second query", async () => {
    const { scope, binding, lines } = await open();
    const inner = scope.m("5", 0) as unknown as Pattern;
    const outer = (scope.m("1 2", 0) as unknown as Pattern).fmap(((value: number) => {
      // A query inside a callback, on a second pattern.
      return binding.query(inner as never, 0, 1).count + value;
    }) as never);
    assert.match(lines(outer), /\| 2 \]\n.*\| 3 \]/);
  });
});

describe("the pick family", () => {
  /** The value of every hap, in the order of the lines. */
  const values = (lines: string): string[] =>
    lines
      .trim()
      .split("\n")
      .map((line) => (line.split("| ").pop() ?? "").replace(" ]", ""));

  test("a lookup is a list or an object, picked by index or by name", async () => {
    const { scope, lines } = await open();
    const base = () => scope.m("0 1", 0) as unknown as Pattern;
    const named = (scope.m("a b", 0) as unknown as Pattern).pick({
      a: scope.m("x", 0),
      b: scope.m("y", 0),
    } as never);
    assert.deepEqual(values(lines(named)).slice(0, 2), ["x", "y"]);
    assert.deepEqual(
      values(lines(base().pick([scope.m("x", 0), scope.m("y", 0)] as never))).slice(0, 2),
      ["x", "y"],
    );
    // A string reads as an object of its characters.
    assert.deepEqual(values(lines(base().pick("xy" as never))).slice(0, 2), ["x", "y"]);
  });

  test("pick clamps an index and pickmod takes the remainder", async () => {
    const { scope, lines } = await open();
    const lookup = () => [scope.m("x", 0), scope.m("y", 0), scope.m("z", 0)] as never;
    const selector = () => scope.m("5", 0) as unknown as Pattern;
    assert.equal(values(lines(selector().pick(lookup())))[0], "z");
    assert.equal(values(lines(selector().pickmod(lookup())))[0], "z");
    const four = () => scope.m("4", 0) as unknown as Pattern;
    assert.equal(values(lines(four().pick(lookup())))[0], "z");
    assert.equal(values(lines(four().pickmod(lookup())))[0], "y");
  });

  test("an empty call and a missing lookup are refused", async () => {
    const { scope, query } = await open();
    const base = scope.m("0", 0) as unknown as Pattern;
    assert.throws(() => base.pick(), { message: ".pick() expects 1 input but got 0." });
    assert.throws(() => base._pick(), { message: "Cannot convert undefined or null to object" });
    assert.throws(() => scope.squeeze(), { message: ".squeeze() expects 2 inputs but got 0." });
    assert.throws(() => scope.squeeze(scope.m("0", 0), "xy"), {
      message: "xs.map is not a function",
    });
    assert.equal(query(base.pickF(scope.m("0", 0), [scope.rev] as never)).thrown, "");
    assert.throws(() => base.pickF(1), { message: ".pickF() expects 2 inputs but got 1." });
  });

  test("a curried free form waits for the selector", async () => {
    const { scope, lines } = await open();
    const lookup = [scope.m("x", 0), scope.m("y", 0)] as never;
    const selector = scope.m("0 1", 0);
    assert.equal(
      lines(scope.pickRestart(lookup)(selector)),
      lines(scope.pickRestart(lookup, selector)),
    );
    assert.equal(typeof scope.pickRestart(lookup), "function");
  });
});

describe("the output methods", () => {
  test("midi keeps the pattern and refuses what the engine runtime refuses", async () => {
    const { scope, lines } = await open();
    const base = () => scope.n(scope.m("0 1", 0)) as unknown as Pattern;
    // No device opens. The pattern gains the port of its output.
    assert.equal(lines(base().midi()), lines(base()).replaceAll(" ]", " midiport:0 ]"));
    assert.match(lines(base().midi(1, { velocity: 1 })), /midiport:1/);
    assert.throws(() => base().midi(scope.m("a b", 0)), {
      message: /needs a port name in SINGLE quotes/,
    });
    assert.throws(() => base().midi(1, 2), { message: ".midi() options must be an object" });
    assert.throws(() => base().midi(1, {}, 3), {
      message: ".midi() accepts at most a port and an options object",
    });
    assert.throws(() => base().midi(() => 1), {
      message:
        ".midi() needs a port name in SINGLE quotes - .midi('IAC Bus 1') - or an index, .midi(0). Double quotes are parsed as mini-notation before .midi() sees them, so the name never arrives. `rustel devices` lists what is plugged in.",
    });
    assert.throws(() => base().serial(1, 2, 3, 4, 5), { message: /accepts at most baud/ });
    assert.throws(() => base().serial(1, 2, 3, scope.m("p", 0)), {
      message: /port in SINGLE quotes/,
    });
  });
});

describe("a score start", () => {
  test("resets the default alignment of the score before", async () => {
    const { host, lines } = await open();
    const result = async (body: string) => lines(await host.evaluate(body, false));
    const untouched = await result("return n(m('0 1', 0)).add(n(m('10 20 30', 0)));");
    await result("setDefaultJoin('out'); return silence;");
    assert.equal(await result("return n(m('0 1', 0)).add(n(m('10 20 30', 0)));"), untouched);
  });
});

describe("the install list", () => {
  test("comes from the registries, in the order of the engine runtime", async () => {
    const { host, scope } = await open();
    const kinds = new Map<number, number>();
    for (const row of host.surface.rows) kinds.set(row.kind, (kinds.get(row.kind) ?? 0) + 1);
    // Combinators, controls, composers, alignments, shortcuts, reads, natives.
    for (const kind of [0, 1, 2, 3, 4, 5, 6]) assert.ok((kinds.get(kind) ?? 0) > 0, `kind ${kind}`);
    assert.equal(kinds.get(3), 8);
    assert.equal(kinds.get(2), 24);
    // The controls come after the pattern combinators, so `density` is the
    // control and not the alias of `fast`.
    const names = host.surface.rows.map((row) => `${row.kind}:${row.name}`);
    assert.ok(names.indexOf("1:density") > names.indexOf("0:fast"));
    // `reset` is both an alignment and a shortcut: the shortcut comes later.
    assert.ok(names.indexOf("4:reset") > names.indexOf("3:reset"));
    assert.equal(typeof scope.fast, "function");
    assert.equal(typeof scope.saw, "object");
  });

  test("a composer is a getter with a member for each alignment", async () => {
    const { scope, lines } = await open();
    const base = scope.n(scope.m("0 1 2", 0)) as Pattern;
    const add = base.add;
    for (const alignment of [
      "in",
      "out",
      "mix",
      "squeeze",
      "squeezein",
      "squeezeout",
      "reset",
      "restart",
      "poly",
    ]) {
      assert.equal(typeof add[alignment], "function", alignment);
    }
    assert.equal(
      lines(add.in(scope.n(scope.m("10 20", 0)))),
      lines(base.add(scope.n(scope.m("10 20", 0)))),
    );
  });
});
