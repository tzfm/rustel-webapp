// The part of the pattern surface for haps and states: the objects
// of the pattern language as globals, `Pattern` as a constructor with a query
// function of the score, and the methods which query a pattern.
//
// Source: `pattern_implementation`, `native_query_method`, `with_haps`,
// `with_hap` (`surface/setup/pattern_surface.rs`, `pattern/mod.rs`).

import type { Binding, PatternObject } from "./binding.ts";
import { FractionFunction, Hap, State, TimeSpan } from "./objects.ts";
import { define, type Surface } from "./surface.ts";
import { isScoreFunction } from "./tape.ts";

type Query = (state: State) => Hap[];

export function installQuery(binding: Binding, surface: Surface): void {
  const { proto, scope } = surface;

  // `new Pattern(query, steps)`: the pattern asks the function for its haps.
  // The function is also the `query` of the object. `Pattern` is an ordinary
  // function so `new Pattern(...)` answers the new pattern, and the
  // prototype is the one of every pattern, so `instanceof` holds.
  function construct(query?: unknown, steps?: unknown): PatternObject {
    if (!isScoreFunction(query)) {
      throw new TypeError("this.query is not a function");
    }
    const pattern = binding.patternFromQuery(query, steps);
    Object.defineProperty(pattern, "query", {
      value: query,
      writable: true,
      configurable: true,
      enumerable: true,
    });
    return pattern;
  }
  construct.prototype = binding.Pattern.prototype;
  scope.Pattern = construct;
  scope.Fraction = FractionFunction;
  scope.TimeSpan = TimeSpan;
  scope.Hap = Hap;
  scope.State = State;

  // `pat.query(state)`: the haps of a pattern for a state.
  define(proto, "query", function (this: PatternObject, state: unknown) {
    if (!(state instanceof State)) throw new TypeError("Pattern.query requires a State");
    return binding.queryState(this, state);
  });

  // `pat.queryArc(begin, end, controls)`: the haps of a span of time.
  define(
    proto,
    "queryArc",
    function (
      this: PatternObject,
      begin: unknown,
      end: unknown,
      controls?: Record<string, unknown>,
    ) {
      return binding.queryState(this, new State(new TimeSpan(begin, end), controls));
    },
  );

  // `pat.withHaps(f)`: a pattern whose haps are `f(haps)` of the haps of `pat`.
  define(
    proto,
    "withHaps",
    function (this: PatternObject & { query: Query }, map: (haps: Hap[]) => Hap[]) {
      if (map === undefined) throw new TypeError(".withHaps() expects 1 inputs but got 0.");
      return construct((state: State) => {
        if (typeof map !== "function") throw new TypeError("func is not a function");
        return map(this.query(state));
      });
    },
  );

  // `pat.withHap(f)`: each hap becomes `f(hap)`.
  define(
    proto,
    "withHap",
    function (
      this: PatternObject & { withHaps: (map: (haps: Hap[]) => Hap[]) => PatternObject },
      map: (hap: Hap) => Hap,
    ) {
      if (map === undefined) throw new TypeError(".withHap() expects 1 inputs but got 0.");
      return this.withHaps((haps) => haps.map(map));
    },
  );
}
