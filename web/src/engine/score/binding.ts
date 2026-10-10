// One instance of the binding module and the objects around the instance: the
// pattern class, the table of score functions, the calls into the module.
//
// Rules this file keeps:
// - A score function which throws never unwinds a wasm frame. `host_call`
//   returns the message as an error.
// - An exception which does leave a wasm frame (a trap, a stack overflow)
//   skips the Rust cleanup of the frame. The instance is poisoned, and the
//   exception passes through `host_call` too. The caller drops the instance.
// - A pattern object owns a handle. A finalizer frees the handle when the
//   object is collected, and `free()` frees the handle at once.

import { createTape, type ScoreFunction, type TaggedFunction, type Tape } from "./tape.ts";

// Captured when the module loads. The lockdown (`lockdown.ts`) removes these
// names from the global object before a score runs, and the glue must not look
// up a name on the global object after the lockdown.
const Wasm = WebAssembly;
const Registry = FinalizationRegistry;

/** The `u32` the module returns for a failed call. */
const FAILED = 0xffffffff;
/** The receiver of a call which has none. */
const NO_RECEIVER = 0xffffffff;
/** The alignment of a composer call which uses the current default. */
export const DEFAULT_ALIGNMENT = 0xffffffff;

// Kind 0 maps a value.
const KIND_PATTERN = 1;
const KIND_BODY = 2;

/** The exports of the module. */
interface Exports {
  memory: WebAssembly.Memory;
  bind_init: () => void;
  bind_tape: () => number;
  bind_tape_cells: () => number;
  bind_scratch: (bytes: number) => number;
  bind_intern: (bytes: number) => number;
  bind_atom_name: (atom: number) => number;
  bind_last_error: () => number;
  bind_free: (handle: number) => void;
  bind_live: () => number;
  bind_install_list: () => number;
  bind_call_combinator: (index: number, receiver: number, cells: number, free: number) => number;
  bind_call_control: (index: number, receiver: number, cells: number, free: number) => number;
  bind_call_composer: (op: number, alignment: number, receiver: number, cells: number) => number;
  bind_call_shortcut: (index: number, receiver: number, cells: number) => number;
  bind_call_native: (index: number, receiver: number, cells: number) => number;
  bind_read: (index: number) => number;
  bind_query_state: (handle: number, cells: number) => number;
  bind_pattern_from_query: (fn: number, cells: number) => number;
  bind_call_registered: (
    fn: number,
    arity: number,
    flags: number,
    join: number,
    name: number,
    receiver: number,
    cells: number,
  ) => number;
  bind_call_effect: (index: number, cells: number) => number;
  bind_call_value: (index: number, cells: number) => number;
  bind_begin_score: () => void;
  bind_query: (handle: number, begin: number, end: number) => number;
  bind_scratch_len: () => number;
  bind_query_context: () => number;
  bind_query_thrown: () => number;
  bind_echo: (cells: number) => number;
}

/** One row of the install list. */
export interface InstallRow {
  kind: number;
  name: string;
  arity: number;
  flags: number;
  index: number;
}

/** A name a score registered: its function and the options of `register`. */
export interface RegisteredName {
  name: string;
  fn: ScoreFunction;
  patternify: boolean;
  preserveSteps: boolean;
  join: ScoreFunction | undefined;
}

/** What a query gave back. */
export interface QueryResult {
  count: number;
  /** The sum of the context lengths of the haps. */
  context: number;
  /** The sorted `show()` lines, one per hap, a newline after each. */
  bytes: Uint8Array;
  /** The message the query threw. Empty after a query which did not throw. */
  thrown: string;
}

/** A pattern of the module. The object holds a handle and nothing else. */
export interface PatternObject {
  handle: number;
  free: () => void;
}

export interface Binding {
  /** The exports of the instance. The engine exports sit on the same instance,
   * so the scheduler turns the instance the binding uses. */
  exports: WebAssembly.Exports;
  /** The class of pattern objects of this instance. */
  Pattern: new (
    handle: number,
  ) => PatternObject;
  tape: Tape;
  installList: () => InstallRow[];
  callCombinator: (
    index: number,
    receiver: PatternObject | null,
    args: unknown[],
    free: boolean,
  ) => PatternObject;
  callControl: (
    index: number,
    receiver: PatternObject | null,
    args: unknown[],
    free: boolean,
  ) => PatternObject;
  callComposer: (
    op: number,
    alignment: number,
    receiver: PatternObject,
    args: unknown[],
  ) => PatternObject;
  callShortcut: (index: number, receiver: PatternObject, args: unknown[]) => PatternObject;
  callNative: (index: number, receiver: PatternObject | null, args: unknown[]) => PatternObject;
  read: (index: number) => PatternObject;
  /** The haps of a pattern for a state: `pattern.query(state)`. */
  queryState: (pattern: PatternObject, state: unknown) => unknown[];
  /** A pattern whose haps come from a function of the score. */
  patternFromQuery: (query: ScoreFunction, steps: unknown) => PatternObject;
  /** Call a name the score registered. */
  callRegistered: (
    registered: RegisteredName,
    receiver: PatternObject | null,
    args: unknown[],
  ) => PatternObject;
  callEffect: (index: number, args: unknown[]) => void;
  /** A name which answers a value and not a pattern. */
  callValue: (index: number, args: unknown[]) => unknown;
  /** Start a score: the timeline offsets and the default alignment start again. */
  beginScore: () => void;
  query: (pattern: PatternObject, begin: number, end: number) => QueryResult;
  /** How many handles are live in the module. */
  live: () => number;
  /** Write a value on the tape, have the module read the value and write the value again. */
  echo: (value: unknown) => unknown;
  /** How many times the module called a score function. */
  crossings: () => number;
  /**
   * The first error a score function threw in this score. The engine swallows such an error
   * in a query, so a caller reads the error here to tell an error from a wrong answer.
   */
  firstThrow: () => string | undefined;
  /** True after an exception left a wasm frame. */
  poisoned: () => boolean;
  /** The message of the last failed call, or of the panic behind a trap. */
  lastError: () => string;
}

/** Compile the module bytes once. Many instances share the result. */
export function compile(bytes: Uint8Array): Promise<WebAssembly.Module> {
  return Wasm.compile(bytes as BufferSource);
}

export async function openBinding(module: WebAssembly.Module): Promise<Binding> {
  const imports = Wasm.Module.imports(module).map((entry) => `${entry.module}.${entry.name}`);
  if (imports.length !== 1 || imports[0] !== "binding.host_call") {
    throw new Error(`the module must import binding.host_call only, not ${imports.join(", ")}`);
  }
  const functions: ScoreFunction[] = []; // callback id to score function
  const ids = new Map<ScoreFunction, number>();
  let poisoned = false;
  let crossings = 0;
  let firstThrow: string | undefined;
  let tape: Tape;
  let wasm: Exports;

  class Pattern implements PatternObject {
    handle: number;
    constructor(handle: number) {
      this.handle = handle;
      collector.register(this, handle, this);
    }

    free(): void {
      if (this.handle === FAILED) return;
      collector.unregister(this);
      wasm.bind_free(this.handle);
      this.handle = FAILED;
    }
  }

  // The module keeps a pattern until the host frees its handle. A pattern
  // object which nothing reaches any more frees its handle here, after the
  // collector ran. Freeing twice is harmless.
  const collector = new Registry<number>((handle) => wasm.bind_free(handle));

  function patternOf(value: unknown): PatternObject {
    if (!(value instanceof Pattern) || value.handle === FAILED) {
      throw new TypeError("expected a live pattern");
    }
    return value;
  }

  const hooks = {
    handleOf: (value: unknown) => (value instanceof Pattern ? patternOf(value).handle : undefined),
    wrap: (handle: number) => new Pattern(handle),
    functionAt(id: number) {
      const found = functions[id];
      if (found === undefined) throw new RangeError(`no function with id ${id}`);
      return found;
    },
    idOf(value: ScoreFunction) {
      let id = ids.get(value);
      if (id === undefined) {
        id = functions.length;
        functions.push(value);
        ids.set(value, id);
      }
      return id;
    },
    tagOf(value: ScoreFunction) {
      const tag = (value as TaggedFunction).__rustel_combinator;
      return tag !== undefined && typeof tag.name === "string" && Array.isArray(tag.args)
        ? tag
        : undefined;
    },
  };

  // kind 0 runs functions[id] on the value on the tape. Kind 1 runs the function
  // on the pattern on the tape and answers a pattern. The answer goes back on the
  // same tape. Returns the answer cell count, or -(n + 1) for a throw with n
  // bytes of message at `address`.
  function hostCall(kind: number, id: number, address: number, cells: number): number {
    crossings += 1;
    try {
      const argument = tape.read(address, cells);
      // A body gets the list on the tape as its arguments.
      const result =
        kind === KIND_BODY ? functions[id](...(argument as unknown[])) : functions[id](argument);
      if (kind === KIND_PATTERN && !(result instanceof Pattern)) {
        throw new TypeError("pattern transformer did not return a pattern");
      }
      return tape.write(result);
    } catch (error) {
      if (poisoned || error instanceof Wasm.RuntimeError) throw error;
      const message = String((error as Error | undefined)?.message ?? error);
      firstThrow ??= `${(error as Error | undefined)?.name ?? "Error"}: ${message}`;
      return -(tape.writeMessage(address, message) + 1);
    }
  }

  const instance = await Wasm.instantiate(module, { binding: { host_call: hostCall } });
  wasm = instance.exports as unknown as Exports;
  wasm.bind_init();
  tape = createTape(wasm, hooks);

  // Every call into the module goes through here. An exception which comes
  // out of an export is a trap or a stack overflow, never a throw of ours.
  function guarded<T>(call: () => T): T {
    try {
      return call();
    } catch (error) {
      poisoned = true;
      throw error;
    }
  }

  function lastError(): string {
    return tape.scratchText(wasm.bind_last_error());
  }

  function made(handle: number): PatternObject {
    const unsigned = handle >>> 0;
    if (unsigned === FAILED) throw new TypeError(lastError());
    return new Pattern(unsigned);
  }

  function receiverOf(receiver: PatternObject | null): number {
    return receiver === null ? NO_RECEIVER : patternOf(receiver).handle;
  }

  return {
    exports: instance.exports,
    Pattern,
    tape,
    installList() {
      const cells = guarded(() => wasm.bind_install_list()) >>> 0;
      if (cells === FAILED) throw new Error(lastError());
      const list = tape.read(tape.address, cells) as (number | string)[];
      const rows: InstallRow[] = [];
      for (let at = 0; at < list.length; at += 5) {
        rows.push({
          kind: list[at] as number,
          name: list[at + 1] as string,
          arity: list[at + 2] as number,
          flags: list[at + 3] as number,
          index: list[at + 4] as number,
        });
      }
      return rows;
    },
    callCombinator(index, receiver, args, free) {
      const cells = tape.write(args);
      return made(
        guarded(() => wasm.bind_call_combinator(index, receiverOf(receiver), cells, free ? 1 : 0)),
      );
    },
    callControl(index, receiver, args, free) {
      const cells = tape.write(args);
      return made(
        guarded(() => wasm.bind_call_control(index, receiverOf(receiver), cells, free ? 1 : 0)),
      );
    },
    callComposer(op, alignment, receiver, args) {
      const cells = tape.write(args);
      return made(
        guarded(() => wasm.bind_call_composer(op, alignment, receiverOf(receiver), cells)),
      );
    },
    callShortcut(index, receiver, args) {
      const cells = tape.write(args);
      return made(guarded(() => wasm.bind_call_shortcut(index, receiverOf(receiver), cells)));
    },
    callNative(index, receiver, args) {
      const cells = tape.write(args);
      return made(guarded(() => wasm.bind_call_native(index, receiverOf(receiver), cells)));
    },
    read: (index) => made(guarded(() => wasm.bind_read(index))),
    queryState(pattern, state) {
      const cells = tape.write([state]);
      const back = guarded(() => wasm.bind_query_state(patternOf(pattern).handle, cells)) >>> 0;
      if (back === FAILED) throw new TypeError(lastError());
      return tape.read(tape.address, back) as unknown[];
    },
    patternFromQuery(query, steps) {
      const cells = tape.write([steps]);
      return made(guarded(() => wasm.bind_pattern_from_query(hooks.idOf(query), cells)));
    },
    callRegistered(registered, receiver, args) {
      const cells = tape.write(args);
      const flags = (registered.patternify ? 1 : 0) | (registered.preserveSteps ? 2 : 0);
      const join = registered.join === undefined ? FAILED : hooks.idOf(registered.join);
      return made(
        guarded(() =>
          wasm.bind_call_registered(
            hooks.idOf(registered.fn),
            Number(registered.fn.length),
            flags,
            join,
            tape.atom(registered.name),
            receiverOf(receiver),
            cells,
          ),
        ),
      );
    },
    callValue(index, args) {
      const cells = tape.write(args);
      const back = guarded(() => wasm.bind_call_value(index, cells)) >>> 0;
      if (back === FAILED) throw new TypeError(lastError());
      return tape.read(tape.address, back);
    },
    beginScore: () => {
      firstThrow = undefined;
      guarded(() => wasm.bind_begin_score());
    },
    callEffect(index, args) {
      const cells = tape.write(args);
      if (guarded(() => wasm.bind_call_effect(index, cells)) >>> 0 === FAILED)
        throw new TypeError(lastError());
    },
    query(pattern, begin, end) {
      const count = guarded(() => wasm.bind_query(patternOf(pattern).handle, begin, end)) >>> 0;
      if (count === FAILED) throw new TypeError(lastError());
      // Copy the lines first: the message of a throw shares the scratch buffer.
      const bytes = tape.scratchBytes(wasm.bind_scratch_len()).slice();
      const context = wasm.bind_query_context();
      const thrown = tape.scratchText(wasm.bind_query_thrown());
      return { count, context, bytes, thrown };
    },
    live: () => wasm.bind_live(),
    echo(value) {
      const cells = tape.write(value);
      const back = guarded(() => wasm.bind_echo(cells)) >>> 0;
      if (back === FAILED) throw new TypeError(lastError());
      return tape.read(tape.address, back);
    },
    crossings: () => crossings,
    firstThrow: () => firstThrow,
    poisoned: () => poisoned,
    lastError,
  };
}
