// The lockdown of the Worker which runs score text. Score text is code from
// anywhere, and the lockdown is the wall inside the Worker. The Worker applies
// the lockdown once, before the first score text runs.
//
// 1. Delete: each own name of the global object, and of each object on its
//    prototype chain, goes away unless the allowlist holds the name. A name
//    which stays throws.
// 2. Freeze: the objects of the allowed names and everything they reach are
//    frozen. A score cannot replace a method which the glue calls later. The
//    global stays extensible, so a score still makes names of its own.
// 3. Verify: the global answers again for each deleted name. A name which
//    comes back throws.
//
// A throw leaves the Worker without an evaluator (fail closed). The Worker
// calls `requireLockdown` before each score text and refuses the text when the
// lockdown did not end well.
//
// The cost of the freeze: a write to a name which a frozen object holds fails.
// Sloppy code ignores the write and strict code throws. Score text is strict
// code (`score.ts` adds the directive), so the write throws. The classes of the
// binding (`Pattern.prototype`) and the surface stay open, because no allowed
// name reaches them. `register` and scores define on them.

/** The names a score keeps. The global holds no other name after the lockdown. */
export const ALLOWED_GLOBALS: readonly string[] = [
  // Values and functions of the language.
  "globalThis",
  "Infinity",
  "NaN",
  "undefined",
  "eval",
  "isFinite",
  "isNaN",
  "parseFloat",
  "parseInt",
  "decodeURI",
  "decodeURIComponent",
  "encodeURI",
  "encodeURIComponent",
  "escape",
  "unescape",
  // Fundamental objects, text, numbers, dates and reflection. `Function` also
  // stays because the score text runs through `new Function`.
  "Object",
  "Function",
  "Boolean",
  "Symbol",
  "Number",
  "BigInt",
  "Math",
  "Date",
  "String",
  "RegExp",
  "JSON",
  "Reflect",
  "Proxy",
  // Collections and promises.
  "Array",
  "Map",
  "Set",
  "WeakMap",
  "WeakSet",
  "Iterator",
  "Promise",
  // Buffers and typed arrays. Not `SharedArrayBuffer`.
  "ArrayBuffer",
  "DataView",
  "Int8Array",
  "Uint8Array",
  "Uint8ClampedArray",
  "Int16Array",
  "Uint16Array",
  "Int32Array",
  "Uint32Array",
  "Float16Array",
  "Float32Array",
  "Float64Array",
  "BigInt64Array",
  "BigUint64Array",
  // Errors.
  "Error",
  "AggregateError",
  "EvalError",
  "RangeError",
  "ReferenceError",
  "SyntaxError",
  "TypeError",
  "URIError",
];

/** The result of the calls on each global object. A failure stays. */
const outcomes = new WeakMap<object, "locked" | "failed">();

type Key = string | symbol;

function isObject(value: unknown): value is object {
  return (typeof value === "object" && value !== null) || typeof value === "function";
}

/**
 * Objects which syntax reaches with no global name: the prototypes behind a
 * function, a generator, an iterator, a regular expression or a promise. The
 * type library of this repository lacks the iterator helpers, so the two calls
 * of the helpers go through a local type.
 */
function syntaxRoots(): unknown[] {
  const { Iterator: iterator } = globalThis as unknown as {
    Iterator: { from: (source: object) => object };
  };
  const values = [].values() as unknown as { map: (map: (value: unknown) => unknown) => object };
  return [
    () => {},
    async () => {},
    function* () {},
    async function* () {},
    (function* () {})(),
    (async function* () {})(),
    [][Symbol.iterator](),
    new Map().entries(),
    new Set().values(),
    ""[Symbol.iterator](),
    "".matchAll(/./g),
    values.map((value) => value),
    iterator.from({ next() {} }),
    /./,
    Promise.resolve(),
  ];
}

/** The prototype, the values, the getters and the setters of an object: what the freeze walks on. */
function reached(object: object): unknown[] {
  const found: unknown[] = [Object.getPrototypeOf(object)];
  for (const key of Reflect.ownKeys(object)) {
    const descriptor = Reflect.getOwnPropertyDescriptor(object, key);
    if (descriptor) found.push(descriptor.value, descriptor.get, descriptor.set);
  }
  return found;
}

/** Freeze every object which the roots reach, except `skip`. The seen set ends a cycle. */
function freezeFrom(roots: unknown[], skip: object): void {
  const seen = new Set<unknown>([skip]);
  while (roots.length > 0) {
    const value = roots.pop();
    if (!isObject(value) || seen.has(value)) continue;
    seen.add(value);
    Object.freeze(value);
    roots.push(...reached(value));
  }
}

function apply(global: object, allowed: ReadonlySet<Key>): void {
  // The syntax roots use names of the language, so they come before the delete step.
  const syntax = syntaxRoots();
  const chain: object[] = [];
  for (
    let object: object | null = global;
    object !== null && object !== Object.prototype;
    object = Object.getPrototypeOf(object)
  ) {
    chain.push(object);
  }

  const deleted = new Set<Key>();
  for (const object of chain) {
    for (const key of Reflect.ownKeys(object)) {
      if (object === global && allowed.has(key)) continue;
      if (!Reflect.deleteProperty(object, key)) {
        throw new Error(`lockdown: ${String(key)} does not delete`);
      }
      deleted.add(key);
    }
  }

  freezeFrom([...reached(global), ...syntax], global);
  // The names which stay are fixed too: a score cannot assign or redefine them.
  for (const key of Reflect.ownKeys(global)) {
    const descriptor = Reflect.getOwnPropertyDescriptor(global, key);
    if (descriptor?.configurable) {
      const fixed =
        "value" in descriptor ? { writable: false, configurable: false } : { configurable: false };
      Object.defineProperty(global, key, fixed);
    }
    const after = Reflect.getOwnPropertyDescriptor(global, key);
    if (after?.writable || after?.configurable) throw new Error(`lockdown: ${String(key)} is open`);
  }

  // A name which the root prototype holds still resolves, as `constructor` does.
  for (const key of deleted) {
    const back =
      !allowed.has(key) && Reflect.has(global, key) && !Reflect.has(Object.prototype, key);
    if (back) throw new Error(`lockdown: ${String(key)} came back`);
  }
  for (const object of chain) {
    for (const key of Reflect.ownKeys(object)) {
      if (object !== global || !allowed.has(key)) {
        throw new Error(`lockdown: ${String(key)} appeared`);
      }
    }
  }
}

/**
 * Apply the lockdown to a global object. Returns when the global holds the
 * allowed names only, and everything they reach is frozen. Throws on the first
 * failure. A call after a failure does not repair the failure: `requireLockdown`
 * goes on to refuse. A second call after a success changes nothing.
 */
export function lockdown(global: object, allowed: Iterable<string>): void {
  try {
    apply(global, new Set<Key>(allowed));
  } catch (error) {
    outcomes.set(global, "failed");
    throw error;
  }
  if (outcomes.get(global) !== "failed") outcomes.set(global, "locked");
}

/** Throws unless `lockdown` ended well on the global. The Worker calls this before each score text. */
export function requireLockdown(global: object): void {
  if (outcomes.get(global) !== "locked") {
    throw new Error("refused: the lockdown did not end well");
  }
}
