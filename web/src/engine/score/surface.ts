// The score surface. At start the host reads the install list of the module
// and defines one name per row. The names, their order and their surface (a
// method, a global, both) come from the engine registries. The calling rules
// stay in the module. A method here encodes its arguments and makes one call.

import { type Binding, DEFAULT_ALIGNMENT, type InstallRow, type PatternObject } from "./binding.ts";
import type { ScoreFunction, TaggedFunction } from "./tape.ts";

// The row kinds and flags of `crates/engine/src/binding/install.rs`.
const COMBINATOR = 0;
const CONTROL = 1;
const COMPOSER = 2;
const ALIGNMENT = 3;
const SHORTCUT = 4;
const READ = 5;
const NATIVE = 6;
const FALLBACK = 7;
const EFFECT = 8;
const VALUE = 9;
const METHOD = 2;
const GLOBAL = 4;
const PLAIN_CURRY = 8;

/** What a score sees: the names of the global scope and the pattern class. */
export interface Surface {
  Pattern: Binding["Pattern"];
  /** The prototype of pattern objects. */
  proto: Record<string, unknown>;
  /** The global names. */
  scope: Record<string, unknown>;
  rows: InstallRow[];
}

type Method = (this: PatternObject, ...args: unknown[]) => unknown;

// A name which a later row replaces must be replaceable: define, never assign.
export function define(target: object, name: string, value: unknown): void {
  Object.defineProperty(target, name, {
    value,
    writable: true,
    enumerable: true,
    configurable: true,
  });
}

function setLength(fn: ScoreFunction, name: string, length: number): void {
  Object.defineProperty(fn, "name", { value: name, configurable: true });
  Object.defineProperty(fn, "length", { value: length, configurable: true });
}

/**
 * The free form of a registered combinator is curried: `fast(2)` waits for a
 * pattern. The function carries a tag with its name and the arguments so far,
 * so the module reads `every(2, fast(2))` as a reference with no callback.
 * Source: the curry text inside `install_combinator` (`surface/mod.rs`).
 */
export function curry(raw: ScoreFunction, arity: number, name: string | undefined): TaggedFunction {
  const make = (collected: unknown[]): TaggedFunction => {
    const fn: TaggedFunction = (...more) => {
      const args = collected.concat(more);
      return args.length >= arity ? raw(...args) : make(args);
    };
    if (name !== undefined) fn.__rustel_combinator = { name, args: collected };
    return fn;
  };
  return make([]);
}

export function installSurface(binding: Binding): Surface {
  const proto: Record<string, unknown> = binding.Pattern.prototype as unknown as Record<
    string,
    unknown
  >;
  const scope: Record<string, unknown> = {};
  const rows = binding.installList();
  // The alignments come before the composers, so a getter lists them.
  const alignments = rows.filter((row) => row.kind === ALIGNMENT);

  function method(name: string, call: Method): void {
    setLength(call, name, 0);
    define(proto, name, call);
  }

  for (const row of rows) {
    const { name, index } = row;
    switch (row.kind) {
      case COMBINATOR: {
        if (row.flags & METHOD) {
          method(name, function (...args) {
            return binding.callCombinator(index, this, args, false);
          });
        }
        if (row.flags & GLOBAL) {
          const raw = (...args: unknown[]) => binding.callCombinator(index, null, args, true);
          // A compatibility registration curries with no tag, so the function
          // passes as a callback and not as a reference.
          define(scope, name, curry(raw, row.arity, row.flags & PLAIN_CURRY ? undefined : name));
        }
        break;
      }
      case CONTROL: {
        if (row.flags & METHOD) {
          method(name, function (...args) {
            return binding.callControl(index, this, args, false);
          });
        }
        if (row.flags & GLOBAL) {
          const free = (...args: unknown[]) => binding.callControl(index, null, args, true);
          setLength(free, name, 1);
          define(scope, name, free);
        }
        break;
      }
      case COMPOSER: {
        // `pat.add(x)` and `pat.add.squeeze(x)`: the getter returns a callable
        // which closes over the pattern and carries one member for each
        // alignment.
        Object.defineProperty(proto, name, {
          configurable: true,
          get(this: PatternObject) {
            const wrapper = (...args: unknown[]) =>
              binding.callComposer(index, DEFAULT_ALIGNMENT, this, args);
            const members = wrapper as unknown as Record<string, unknown>;
            for (const alignment of alignments) {
              members[alignment.name] = (...args: unknown[]) =>
                binding.callComposer(index, alignment.index, this, args);
            }
            members.squeezein = members.squeeze;
            return wrapper;
          },
        });
        break;
      }
      case SHORTCUT: {
        method(name, function (...args) {
          return binding.callShortcut(index, this, args);
        });
        break;
      }
      case VALUE: {
        const value = (...args: unknown[]) => binding.callValue(index, args);
        setLength(value, name, row.arity);
        define(scope, name, value);
        break;
      }
      case EFFECT: {
        const effect = (...args: unknown[]) => {
          binding.callEffect(index, args);
        };
        setLength(effect, name, row.arity);
        define(scope, name, effect);
        break;
      }
      case FALLBACK: {
        // `install_method_fallback` (`install/compat/bindings.rs`): when no
        // global has the name, `add(1, pattern)` calls `pattern.add(1)`. The
        // last argument is the receiver. `superimpose` takes its functions as
        // a list.
        const arity = row.arity;
        if (scope[name] !== undefined || typeof proto[name] !== "function") break;
        const raw = (...args: unknown[]) => {
          if (args.length < arity) return undefined;
          const terminal = args[arity - 1];
          const receiver = (
            terminal instanceof binding.Pattern ? terminal : (scope.pure as ScoreFunction)(terminal)
          ) as Record<string, ScoreFunction>;
          const method = receiver[name];
          if (name === "superimpose") {
            if (!Array.isArray(args[0])) throw new TypeError("not iterable");
            return method.apply(receiver, args[0]);
          }
          return method.apply(receiver, args.slice(0, arity - 1));
        };
        define(scope, name, curry(raw, arity, undefined));
        break;
      }
      case READ: {
        define(scope, name, binding.read(index));
        break;
      }
      case NATIVE: {
        if (row.flags & METHOD) {
          method(name, function (...args) {
            return binding.callNative(index, this, args);
          });
        }
        if (row.flags & GLOBAL) {
          const global = (...args: unknown[]) => binding.callNative(index, null, args);
          setLength(global, name, row.arity);
          // A native curried like the pick family waits for all its arguments.
          define(
            scope,
            name,
            row.flags & PLAIN_CURRY ? curry(global, row.arity, undefined) : global,
          );
        }
        break;
      }
      default:
        break;
    }
  }
  return { Pattern: binding.Pattern, proto, scope, rows };
}
