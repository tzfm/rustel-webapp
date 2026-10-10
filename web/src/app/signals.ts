// A small signal and effect pair. An effect runs once at the start. Then the
// effect runs again, in a microtask, after a signal the effect read changes.
// Several changes in one task cause one run.

export interface Signal<T> {
  get(): T;
  set(value: T): void;
}

interface Effect {
  body: () => void;
  /** The reader set of each signal the last run read. */
  sources: Set<Set<Effect>>;
  stopped: boolean;
}

let active: Effect | undefined;
let queue = new Set<Effect>();

function leave(effect: Effect): void {
  for (const readers of effect.sources) readers.delete(effect);
  effect.sources.clear();
}

function run(effect: Effect): void {
  leave(effect);
  const outer = active;
  active = effect;
  try {
    effect.body();
  } finally {
    active = outer;
  }
}

function flush(): void {
  const batch = queue;
  queue = new Set();
  for (const effect of batch) if (!effect.stopped) run(effect);
}

export function signal<T>(initial: T): Signal<T> {
  let value = initial;
  const readers = new Set<Effect>();
  return {
    get() {
      if (active) {
        readers.add(active);
        active.sources.add(readers);
      }
      return value;
    },
    set(next) {
      if (Object.is(next, value)) return;
      value = next;
      if (readers.size > 0 && queue.size === 0) queueMicrotask(flush);
      for (const reader of readers) queue.add(reader);
    },
  };
}

/** Runs `body` now and after each change of a signal `body` read. Returns a
 * function which stops the effect. */
export function effect(body: () => void): () => void {
  const created: Effect = { body, sources: new Set(), stopped: false };
  run(created);
  return () => {
    created.stopped = true;
    leave(created);
  };
}
