// The JavaScript side of the value tape. A value crosses as a run of 16-byte
// cells in pre-order. The Rust side (`crates/engine/src/binding/tape.rs`) holds the layout.
//
// Rules this file keeps:
// - A wasm call grows memory at times, and growth detaches the typed-array views.
//   The views are checked before each use, never kept across a wasm call.
// - A string crosses as an atom, a u32. A string the module does not know is
//   sent once. A string the module knows and this side does not is asked for
//   once.
// - A value nests 64 levels at most.
// - A fraction crosses exact, as two 64-bit integers, or as text past 64 bits.

import { Fraction, Hap, State, TimeSpan } from "./objects.ts";

export const UNDEFINED = 0;
export const NULL = 1;
export const BOOL = 2;
export const F64 = 3;
export const STR = 4;
export const LIST = 5;
export const OBJECT = 6;
export const PATTERN = 7;
export const FUNC = 8;
export const REF = 9;
export const I64 = 10;
export const FRAC = 11;
export const SPAN = 12;
export const HAP = 13;
export const STATE = 14;

// Made when the module loads. The lockdown (`lockdown.ts`) removes the text
// coders from the global object before a score runs, and the glue must not look
// up a name on the global object after the lockdown.
const decoder = new TextDecoder();
const encoder = new TextEncoder();

/** Flag bit 0, shifted into the first 32-bit word of a cell. */
const KEYED = 1 << 8;
const MAX_DEPTH = 64;
const OWN = { writable: true, enumerable: true, configurable: true };
const I64_MIN = -(2n ** 63n);
const I64_MAX = 2n ** 63n - 1n;

/** A function of a score. The tape carries any value as an argument. */
export type ScoreFunction = (...args: unknown[]) => unknown;

/** True for a function of a score. */
export function isScoreFunction(value: unknown): value is ScoreFunction {
  return typeof value === "function";
}

/** The name and the collected arguments of an installed combinator. */
export interface Combinator {
  name: string;
  args: unknown[];
}

/** A curried function of the surface. The tag lets the module read a reference. */
export type TaggedFunction = ScoreFunction & { __rustel_combinator?: Combinator };

/** The exports of the module which the tape needs. */
export interface TapeExports {
  memory: WebAssembly.Memory;
  bind_tape: () => number;
  bind_tape_cells: () => number;
  bind_scratch: (bytes: number) => number;
  bind_intern: (bytes: number) => number;
  bind_atom_name: (atom: number) => number;
}

/** What the tape needs to know about the host objects the tape carries. */
export interface TapeHooks {
  /** The handle of a pattern object, or undefined for any other value. */
  handleOf: (value: unknown) => number | undefined;
  /** A pattern object for a handle the module gave out. */
  wrap: (handle: number) => unknown;
  /** The id of a function. The same function keeps its id. */
  idOf: (value: ScoreFunction) => number;
  /** The function behind an id the module sent back. */
  functionAt: (id: number) => ScoreFunction;
  /** The tag of an installed combinator: its name and collected arguments. */
  tagOf: (value: ScoreFunction) => Combinator | undefined;
}

export interface Tape {
  /** Write `value` at the start of the tape. Returns the cell count. */
  write: (value: unknown) => number;
  /** Read the value at `address`, `cells` cells long. */
  read: (address: number, cells: number) => unknown;
  /** The address of the first cell. */
  address: number;
  /** The text in the scratch buffer, copied out. */
  scratchText: (length: number) => string;
  /** The bytes in the scratch buffer. A view, valid until the next wasm call. */
  scratchBytes: (length: number) => Uint8Array;
  /** Write a UTF-8 message at `address`. Returns the byte length. */
  writeMessage: (address: number, message: string) => number;
  /** The capacity in bytes. */
  bytes: number;
  atomCount: () => number;
  /** The atom of a string, for the names the module reads by atom. */
  atom: (name: string) => number;
}

export function createTape(wasm: TapeExports, hooks: TapeHooks): Tape {
  const names: string[] = []; // atom to string
  const atoms = new Map<string, number>(); // string to atom
  const shadowed = new Set<number>(); // the atoms of the names `Object.prototype` holds
  let u8 = new Uint8Array(0);
  let u32 = new Uint32Array(0);
  let f64 = new Float64Array(0);
  let i64 = new BigInt64Array(0);
  let at = 0; // byte offset of the next cell
  let end = 0; // byte offset one past the tape
  const address = wasm.bind_tape();
  const bytes = wasm.bind_tape_cells() * 16;

  function view(): void {
    if (u8.buffer === wasm.memory.buffer) return;
    const buffer = wasm.memory.buffer;
    u8 = new Uint8Array(buffer);
    u32 = new Uint32Array(buffer);
    f64 = new Float64Array(buffer);
    i64 = new BigInt64Array(buffer);
  }

  function learn(name: string, atom: number): void {
    names[atom] = name;
    atoms.set(name, atom);
    if (name in Object.prototype) shadowed.add(atom);
  }

  // A string the module knows and this side does not: ask for its text, once.
  function fetchName(atom: number): string {
    const length = wasm.bind_atom_name(atom);
    const pointer = wasm.bind_scratch(0);
    view();
    const name = decoder.decode(u8.subarray(pointer, pointer + length));
    learn(name, atom);
    return name;
  }

  // A string this side knows and the module does not: send its text, once.
  function intern(name: string): number {
    const text = encoder.encode(name);
    const pointer = wasm.bind_scratch(text.length);
    view();
    u8.set(text, pointer);
    const atom = wasm.bind_intern(text.length);
    learn(name, atom);
    return atom;
  }

  function atomOf(name: string): number {
    return atoms.get(name) ?? intern(name);
  }

  function nameOf(atom: number): string {
    return names[atom] ?? fetchName(atom);
  }

  function readCell(depth: number): unknown {
    if (depth > MAX_DEPTH) throw new RangeError("value nests too deep for the tape");
    const cell = at;
    at = cell + 16;
    switch (u8[cell]) {
      case F64:
        return f64[(cell >> 3) + 1];
      case STR:
        return nameOf(u32[(cell >> 2) + 2]);
      case OBJECT: {
        const count = u32[(cell >> 2) + 2];
        const object: Record<string, unknown> = {};
        for (let index = 0; index < count; index += 1) {
          const atom = u32[(at >> 2) + 1];
          const key = nameOf(atom);
          const member = readCell(depth + 1);
          // An assignment to "__proto__" sets the prototype. An assignment to
          // "toString" throws once the lockdown froze `Object.prototype`.
          // Define the member in both cases.
          if (shadowed.has(atom)) Object.defineProperty(object, key, { ...OWN, value: member });
          else object[key] = member;
        }
        return object;
      }
      case LIST: {
        const count = u32[(cell >> 2) + 2];
        const list = new Array<unknown>(count);
        for (let index = 0; index < count; index += 1) list[index] = readCell(depth + 1);
        return list;
      }
      case BOOL:
        return u8[cell + 8] !== 0;
      case NULL:
        return null;
      case PATTERN:
        return hooks.wrap(u32[(cell >> 2) + 2]);
      case FUNC:
        return hooks.functionAt(u32[(cell >> 2) + 2]);
      case REF: {
        // The function stands for the reference: skip the name and the
        // collected arguments.
        const id = u32[(cell >> 2) + 2];
        for (let child = u32[(cell >> 2) + 3]; child > 0; child -= 1) readCell(depth + 1);
        return hooks.functionAt(id);
      }
      case FRAC: {
        if (u32[(cell >> 2) + 2] === 1) {
          const [numerator, denominator] = (readCell(depth + 1) as string).split("/");
          return Fraction.of(BigInt(numerator), BigInt(denominator));
        }
        const numerator = i64[(at >> 3) + 1];
        const denominator = i64[(at >> 3) + 3];
        at += 32;
        return Fraction.of(numerator, denominator);
      }
      case SPAN: {
        const begin = readCell(depth + 1) as Fraction;
        const end = readCell(depth + 1) as Fraction;
        return Object.assign(Object.create(TimeSpan.prototype) as TimeSpan, { begin, end });
      }
      case HAP: {
        const whole = readCell(depth + 1) as TimeSpan | undefined;
        const part = readCell(depth + 1) as TimeSpan;
        const value = readCell(depth + 1);
        const context = readCell(depth + 1) as Record<string, unknown>;
        const stateful = readCell(depth + 1) as boolean;
        return new Hap(whole, part, value, context, stateful);
      }
      case STATE: {
        const span = readCell(depth + 1) as TimeSpan;
        const controls = readCell(depth + 1) as Record<string, unknown>;
        return new State(span, controls);
      }
      case UNDEFINED:
        return undefined;
      default:
        throw new TypeError(`unknown tape tag ${u8[cell]}`);
    }
  }

  // `head` is the flag bits of the first word. `key` is the member atom.
  function writeCell(value: unknown, head: number, key: number, depth: number): void {
    if (depth > MAX_DEPTH) throw new RangeError("value nests too deep for the tape");
    const cell = at;
    if (cell >= end) throw new RangeError("value is larger than the tape");
    at = cell + 16;
    const word = cell >> 2;
    switch (typeof value) {
      case "number":
        u32[word] = F64 | head;
        u32[word + 1] = key;
        f64[(cell >> 3) + 1] = value;
        return;
      case "string": {
        // Look the atom up first: a new one calls the module, and the views move.
        const atom = atomOf(value);
        view();
        u32[word] = STR | head;
        u32[word + 1] = key;
        u32[word + 2] = atom;
        return;
      }
      case "boolean":
        u32[word] = BOOL | head;
        u32[word + 1] = key;
        u8[cell + 8] = value ? 1 : 0;
        return;
      case "undefined":
        u32[word] = UNDEFINED | head;
        u32[word + 1] = key;
        return;
      case "function": {
        const tag = hooks.tagOf(value as ScoreFunction);
        const id = hooks.idOf(value as ScoreFunction);
        if (tag === undefined) {
          u32[word] = FUNC | head;
          u32[word + 1] = key;
          u32[word + 2] = id;
          return;
        }
        // The head cell holds the id and the child count. The children are
        // the name, then the collected arguments.
        u32[word + 2] = id;
        u32[word + 3] = tag.args.length + 1;
        writeCell(tag.name, 0, 0, depth + 1);
        for (const bound of tag.args) writeCell(bound, 0, 0, depth + 1);
        view();
        u32[word] = REF | head;
        u32[word + 1] = key;
        return;
      }
      case "object": {
        if (value === null) {
          u32[word] = NULL | head;
          u32[word + 1] = key;
          return;
        }
        if (value instanceof Fraction) {
          writeFraction(value, word, head, key, depth);
          return;
        }
        if (value instanceof TimeSpan || value instanceof Hap || value instanceof State) {
          writeObject(value, word, head, key, depth);
          return;
        }
        const handle = hooks.handleOf(value);
        if (handle !== undefined) {
          u32[word] = PATTERN | head;
          u32[word + 1] = key;
          u32[word + 2] = handle;
          return;
        }
        let tag = LIST;
        let count = 0;
        if (Array.isArray(value)) {
          count = value.length;
          for (let index = 0; index < count; index += 1) writeCell(value[index], 0, 0, depth + 1);
        } else {
          tag = OBJECT;
          const members = value as Record<string, unknown>;
          // for-in is the fast walk, and for an ordinary object gives the own keys.
          for (const name in members) {
            if (!Object.hasOwn(members, name)) continue;
            const atom = atomOf(name);
            view();
            writeCell(members[name], KEYED, atom, depth + 1);
            count += 1;
          }
        }
        view();
        u32[word] = tag | head;
        u32[word + 1] = key;
        u32[word + 2] = count;
        return;
      }
      default:
        throw new TypeError(`a ${typeof value} does not cross the tape`);
    }
  }

  // A fraction: two 64-bit integers, the numerator with its sign, or the text
  // `n/d` when a part does not fit.
  function writeFraction(
    value: Fraction,
    word: number,
    head: number,
    key: number,
    depth: number,
  ): void {
    const numerator = value.s * value.n;
    if (numerator >= I64_MIN && numerator <= I64_MAX && value.d <= I64_MAX) {
      const first = at;
      if (first + 32 > end) throw new RangeError("value is larger than the tape");
      at = first + 32;
      u32[word] = FRAC | head;
      u32[word + 1] = key;
      u32[word + 2] = 2;
      u32[word + 3] = 0;
      u8[first] = I64;
      i64[(first >> 3) + 1] = numerator;
      u8[first + 16] = I64;
      i64[(first >> 3) + 3] = value.d;
      return;
    }
    u32[word + 2] = 1;
    u32[word + 3] = 0;
    writeCell(`${numerator}/${value.d}`, 0, 0, depth + 1);
    view();
    u32[word] = FRAC | head;
    u32[word + 1] = key;
  }

  // A span, a hap or a state: a head cell, then the fields in order.
  function writeObject(
    value: TimeSpan | Hap | State,
    word: number,
    head: number,
    key: number,
    depth: number,
  ): void {
    let fields: unknown[];
    let tag: number;
    if (value instanceof TimeSpan) {
      [tag, fields] = [SPAN, [value.begin, value.end]];
    } else if (value instanceof Hap) {
      [tag, fields] = [
        HAP,
        [value.whole, value.part, value.value, value.context ?? {}, Boolean(value.stateful)],
      ];
    } else {
      [tag, fields] = [STATE, [value.span, value.controls ?? {}]];
    }
    u32[word + 2] = fields.length;
    u32[word + 3] = 0;
    for (const field of fields) writeCell(field, 0, 0, depth + 1);
    view();
    u32[word] = tag | head;
    u32[word + 1] = key;
  }

  view();
  return {
    address,
    bytes,
    atomCount: () => names.length,
    atom: atomOf,
    write(value) {
      view();
      at = address;
      end = address + bytes;
      writeCell(value, 0, 0, 0);
      return (at - address) >> 4;
    },
    read(from, cells) {
      view();
      at = from;
      const value = readCell(0);
      if (at - from !== cells << 4) throw new Error("the tape and its length disagree");
      return value;
    },
    scratchText(length) {
      const pointer = wasm.bind_scratch(0);
      view();
      return decoder.decode(u8.subarray(pointer, pointer + length));
    },
    scratchBytes(length) {
      const pointer = wasm.bind_scratch(0);
      view();
      return u8.subarray(pointer, pointer + length);
    },
    writeMessage(to, message) {
      const text = encoder.encode(message).subarray(0, bytes);
      view();
      u8.set(text, to);
      return text.length;
    },
  };
}
