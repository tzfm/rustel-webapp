// `register`: a score gives a name and a function body. The name becomes a
// method of patterns and a curried function. The calling rules (which
// arguments become patterns, when the body runs) are in the module. This
// file holds what is JavaScript state: the function, the surface, and the
// names the engine had before a score took them.
//
// Source: `register_one`, `remember_displaced`, `restore_surface`
// (`surface/setup/registration.rs`).

import type { Binding, PatternObject } from "./binding.ts";
import { curry, define, type Surface } from "./surface.ts";
import { isScoreFunction, type ScoreFunction } from "./tape.ts";

/** The options of `register`, after the defaults. */
interface Options {
  fn: ScoreFunction;
  patternify: boolean;
  preserveSteps: boolean;
  join: ScoreFunction | undefined;
}

export interface Registrations {
  /** The `register` function of the score surface. */
  register: (
    name: unknown,
    fn: unknown,
    patternify?: unknown,
    preserveSteps?: unknown,
    join?: unknown,
  ) => unknown;
  /** Give back the names the last score took from the engine. */
  restore: () => void;
}

/**
 * Define `register` on the surface. A name the engine installed is refused,
 * except the names of its extensions. A name which a score took from the
 * engine goes back at the start of the next score. A new name stays.
 */
export function installRegister(binding: Binding, surface: Surface): Registrations {
  const { proto } = surface;
  const extensions = new Set(
    surface.rows.filter((row) => row.flags & EXTENSION).map((row) => row.name),
  );
  const sealed = new Set(Object.getOwnPropertyNames(proto).filter((name) => !extensions.has(name)));
  // What each name meant before this score took the name, taken once.
  const displaced = new Map<string, PropertyDescriptor | undefined>();

  function remember(name: string): void {
    if (displaced.has(name)) return;
    displaced.set(name, Object.getOwnPropertyDescriptor(proto, name));
  }

  function one(name: unknown, options: Options): unknown {
    if (name && (name instanceof binding.Pattern || (name as { _Pattern?: unknown })._Pattern)) {
      throw new Error(
        "Name argument for register is a pattern, try using single quotes ('name') instead of double quotes (\"name\")",
      );
    }
    if (Array.isArray(name)) {
      // Entries are defined, not assigned: a name such as `toString` sits on
      // the frozen object prototype after the lockdown.
      return Object.fromEntries(name.map((item) => [String(item), one(item, options)]));
    }
    const text = String(name);
    if (sealed.has(text)) {
      throw new Error(
        `register('${text}') would replace the existing built-in '${text}'. Pick a different name.`,
      );
    }
    remember(text);
    const registered = { name: text, ...options };
    const arity = Number(options.fn.length);
    define(proto, text, function (this: PatternObject, ...args: unknown[]) {
      return binding.callRegistered(registered, this, args);
    });
    return curry(
      (...args: unknown[]) => binding.callRegistered(registered, null, args),
      arity,
      undefined,
    );
  }

  return {
    register(name, fn, patternify, preserveSteps, join) {
      if (!isScoreFunction(fn)) throw new TypeError("func is not a function");
      const options: Options = {
        fn,
        patternify: patternify === undefined ? true : Boolean(patternify),
        preserveSteps: preserveSteps === undefined ? false : Boolean(preserveSteps),
        join: isScoreFunction(join) ? join : undefined,
      };
      if (join !== undefined && options.join === undefined)
        throw new TypeError("join is not a function");
      return one(name, options);
    },
    restore() {
      for (const [name, before] of displaced) {
        // A name nothing answered to stays: a helper declared by one score
        // is there for the next.
        if (before !== undefined) Object.defineProperty(proto, name, before);
      }
      displaced.clear();
    },
  };
}

/** The flag of a row for an extension name, see `crates/engine/src/binding/install.rs`. */
const EXTENSION = 16;
