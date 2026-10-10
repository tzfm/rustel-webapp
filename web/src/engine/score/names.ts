// The hand-written names which hold host state and no pattern rule: the lanes
// of `.p` and `all`, the tempo setters, `samples`. Each comment names the
// function of the engine runtime which holds the rule.

import type { PatternObject } from "./binding.ts";
import type { Surface } from "./surface.ts";

/** What a score asked of its host. A failed score changes nothing. */
export interface Effects {
  /** Cycles per second, from the last tempo setter. */
  cps: number | undefined;
  /** How many calls of `samples` the score made. */
  samples: number;
}

export interface ScoreNames {
  effects: Effects;
  /** Forget the lanes and the effects of the last score. */
  reset: () => void;
  /** Put the lanes together after the score returned. */
  finish: (returned: unknown) => unknown;
}

const TEMPO_VALUE_POLICY = "setCps and setCpm need a finite tempo above zero";

/**
 * Define the names on `surface`. The silence and the `stack` of the module
 * must already be there.
 */
export function installNames(surface: Surface): ScoreNames {
  const { scope, proto } = surface;
  const silence = scope.silence as PatternObject;
  const stack = scope.stack as (...patterns: unknown[]) => PatternObject;
  const effects: Effects = { cps: undefined, samples: 0 };
  // A lane id is a property key, so an integer id sorts first, as in the
  // engine runtime. The object has no prototype.
  let lanes: Record<string, PatternObject> = Object.create(null);
  let anonymous = 0;
  let allTransform: unknown = null;

  function reset(): void {
    lanes = Object.create(null);
    anonymous = 0;
    allTransform = null;
    effects.cps = undefined;
    effects.samples = 0;
  }

  // `collect` (`install/repl/lanes.rs`): `.p(id)` keeps the pattern as a lane.
  // An id which starts or ends with an underscore mutes the lane. An id with a
  // `$` gets the running number of anonymous lanes appended.
  Object.defineProperty(proto, "p", {
    value: function (this: PatternObject, ...args: unknown[]) {
      let id = args[0];
      if (typeof id === "string") {
        if (id.startsWith("_") || id.endsWith("_")) return silence;
        if (id.includes("$")) {
          id = `${id}${anonymous}`;
          anonymous += 1;
        }
      }
      lanes[id as string] = this;
      return this;
    },
    writable: true,
    enumerable: true,
    configurable: true,
  });
  // `quiet`: `.q()` takes the lane out.
  Object.defineProperty(proto, "q", {
    value: () => silence,
    writable: true,
    enumerable: true,
    configurable: true,
  });

  // `all` (`install/repl/lanes.rs`): remember the transform for the end.
  scope.all = (transform: unknown) => {
    allTransform = transform;
    return silence;
  };

  // `NativeTempoSetter` (`install/repl/tempo.rs`): a tempo setter stages the
  // new tempo and returns silence. A missing or null value throws. A pattern
  // has no pure value here, so `setCps` takes half a cycle per second and
  // `setCpm` refuses the pattern. `setCpm` divides by 60. A tempo which is not a
  // finite number above zero is refused.
  const tempo = (perMinute: boolean) => (value?: unknown) => {
    if (value === null || value === undefined) {
      throw new TypeError(`Cannot read properties of ${value} (reading '_Pattern')`);
    }
    const raw = value instanceof surface.Pattern ? undefined : value;
    let cps: unknown = perMinute ? Number(raw) / 60 : raw === undefined ? 0.5 : raw;
    if (typeof cps !== "number" || !Number.isFinite(cps) || cps <= 0) cps = undefined;
    if (cps === undefined) throw new RangeError(TEMPO_VALUE_POLICY);
    effects.cps = cps as number;
    return silence;
  };
  for (const name of ["setCps", "setcps", "cps"]) scope[name] = tempo(false);
  for (const name of ["setCpm", "setcpm"]) scope[name] = tempo(true);

  // `set_gain_curve` and `APPLY_GAIN_CURVE` (`install/native_surface/bindings.rs`,
  // `install/repl/lanes.rs`): the curve shapes the gain and the velocity of
  // every value after the lanes and `all`. The curve outlasts a score until
  // another call replaces the curve.
  let gainCurve: unknown;
  scope.setGainCurve = (curve?: unknown) => {
    gainCurve = curve;
  };

  // `samples` records a sample source and answers a resolved promise. The
  // transpiler awaits a bare call. Nothing loads.
  scope.samples = () => {
    effects.samples += 1;
    return Promise.resolve();
  };

  // `finish` (`install/repl/lanes.rs`): the lanes are stacked, the solo lanes
  // (an id of two characters or more which starts with `S`) replace the
  // others, and `all` transforms the result.
  function finish(returned: unknown): unknown {
    const selected: PatternObject[] = [];
    let solo = false;
    for (const [id, pattern] of Object.entries(lanes)) {
      const isSolo = id.length > 1 && id.startsWith("S");
      if (isSolo && !solo) {
        selected.length = 0;
        solo = true;
      }
      if (!solo || isSolo) selected.push(pattern);
    }
    let result = selected.length === 0 ? returned : stack(...selected);
    if (allTransform) {
      if (typeof allTransform !== "function")
        throw new TypeError("all transform is not a function");
      result = allTransform(result);
    }
    if (typeof gainCurve === "function")
      result = shapeGain(result, gainCurve as (gain: unknown) => unknown);
    return result;
  }

  // Only a value with members carries controls. Any other value stays.
  function shapeGain(result: unknown, curve: (gain: unknown) => unknown): unknown {
    const pattern = result as { withValue?: (map: (value: unknown) => unknown) => unknown };
    if (!pattern || typeof pattern.withValue !== "function") return result;
    return pattern.withValue((value) => {
      if (value === null || typeof value !== "object" || Array.isArray(value)) return value;
      const members = value as Record<string, unknown>;
      const shaped: Record<string, unknown> = { ...members, gain: curve(members.gain ?? 0.8) };
      if (members.velocity !== undefined) shaped.velocity = curve(members.velocity);
      return shaped;
    });
  }

  return { effects, reset, finish };
}
