// The two Workers of the engine frame. The first Worker plays. The second one,
// the standby, evaluates the last good score and makes no event. The frame page
// looks at the turn count of the first Worker every 20 ms. When the Worker
// hangs, traps or dies, the frame page ends the Worker and promotes the
// standby. The standby continues the music from the position in the bridge. The
// frame page then starts a new standby from the compiled modules.
//
// Which score is to blame decides what the standby plays. A score which was
// evaluating when the Worker failed is to blame, and the standby plays the last
// good score. When no score was evaluating, the last good score itself failed
// inside a turn, for example in a function the score calls at query time. The standby
// would fail the same way, so the standby plays silence.

import type { FromFrame, Reason, ToFrame } from "../protocol.ts";
import { recoveryText } from "../protocol.ts";
import {
  type Bridge,
  bridgeBytes,
  handOver,
  isPlaying,
  openBridge,
  setStop,
  turnCount,
} from "./bridge.ts";
import { look, type Pulse, pulseAt } from "./watchdog.ts";
import type { FromWorker, ToWorker } from "./worker.ts";

/** Milliseconds between two looks at the Worker which plays. */
const WATCH_MS = 20;
/** Milliseconds the standby gets to keep a score. A standby makes no turns, so
 * a deadline takes the place of the turn count. */
const HOLD_MS = 5000;

/** The messages of the page which the Worker which plays handles. */
export type ToPlaying = Extract<ToFrame, { type: "play" | "set" | "stop" }>;

export interface Parts {
  engine: WebAssembly.Module;
  transpiler: WebAssembly.Module;
  sampleRate: number;
  /** Sends a message to the app page. */
  send: (message: FromFrame) => void;
}

/** What the frame needs to build the renderer, and the way to the Workers. */
export interface Opened {
  buffer: SharedArrayBuffer;
  bridge: Bridge;
  /** Bytes of one event record. */
  recordBytes: number;
  /** The canonical event of the engine module, for the check of the renderer. */
  canonical: Uint8Array;
  /** Posts a message to the Worker which plays, after a recovery in progress
   * ends. A play clears the stop word first. */
  post: (message: ToPlaying) => Promise<void>;
}

interface Waiter {
  resolve: (reply: FromWorker) => void;
  reject: (error: Error) => void;
}

interface Slot {
  worker: Worker;
  /** The number of the Worker in the producer word of the bridge. */
  id: number;
  /** True after the Worker is ended or failed: its messages do not count. */
  gone: boolean;
  /** The text the Worker holds as the last good score, or null for silence. */
  held: string | null;
  /** Settles when every message sent to the Worker has an answer. Never rejects. */
  settled: Promise<void>;
  /** True for the standby which replaced a failed standby. */
  second: boolean;
  /** Messages waiting for an answer. The key is the id, or the type for an answer with no id. */
  waiting: Map<string | number, Waiter>;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Starts the first Worker and its standby, and returns the bridge. */
export async function openPair(parts: Parts): Promise<Opened> {
  const { send } = parts;
  let bridge: Bridge;
  let buffer: SharedArrayBuffer;
  let active: Slot;
  let standby: Slot | undefined;
  /** False until the first Worker is attached: a failure before then stops the page. */
  let live = false;
  /** The text of the last score the Worker which plays answered. */
  let lastGood: string | null = null;
  /** The scores sent to the Worker which plays and not yet answered, by id. */
  const inflight = new Map<number, string>();
  let recovering: Promise<void> | undefined;
  let pulse: Pulse = pulseAt(0, performance.now());
  let ids = 0;

  function spawn(second: boolean): { slot: Slot; layout: Promise<FromWorker> } {
    const worker = new Worker(new URL("worker.js", import.meta.url), { type: "module" });
    const slot: Slot = {
      worker,
      id: ++ids,
      gone: false,
      held: null,
      settled: Promise.resolve(),
      second,
      waiting: new Map(),
    };
    worker.onmessage = (event: MessageEvent<FromWorker>) => received(slot, event.data);
    worker.onerror = (event) => failed(slot, "death", `The engine Worker failed. ${event.message}`);
    const layout = ask(slot, "layout", {
      type: "init",
      engine: parts.engine,
      transpiler: parts.transpiler,
      sampleRate: parts.sampleRate,
    });
    return { slot, layout };
  }

  /** Posts the message, and resolves with the answer under `key`. */
  function ask(
    slot: Slot,
    key: string | number,
    message: ToWorker,
    limit?: number,
  ): Promise<FromWorker> {
    return new Promise((resolve, reject) => {
      const timer =
        limit === undefined
          ? undefined
          : setTimeout(() => {
              slot.waiting.delete(key);
              reject(new Error("The standby gave no answer."));
            }, limit);
      slot.waiting.set(key, {
        resolve: (reply) => {
          clearTimeout(timer);
          resolve(reply);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      slot.worker.postMessage(message);
    });
  }

  function answer(slot: Slot, key: string | number, reply: FromWorker): void {
    slot.waiting.get(key)?.resolve(reply);
    slot.waiting.delete(key);
  }

  function received(slot: Slot, data: FromWorker): void {
    if (slot.gone) return;
    switch (data.type) {
      case "layout":
      case "ready":
        answer(slot, data.type, data);
        break;
      case "held":
      case "promoted":
        answer(slot, data.id, data);
        break;
      case "done": {
        const text = inflight.get(data.id);
        inflight.delete(data.id);
        if (text !== undefined) remember(text);
        send(data);
        break;
      }
      case "failed":
        inflight.delete(data.id);
        send(data);
        break;
      case "fatal":
        failed(slot, "trap", data.error);
        break;
    }
  }

  /** Ends the Worker. Every message which waits for an answer fails. */
  function end(slot: Slot, detail: string): void {
    if (slot.gone) return;
    slot.gone = true;
    slot.worker.terminate();
    for (const { reject } of slot.waiting.values()) reject(new Error(detail));
    slot.waiting.clear();
  }

  function failed(slot: Slot, reason: Reason, detail: string): void {
    if (slot.gone) return;
    end(slot, detail);
    // Before the first Worker is attached, the failed message ends `openPair`.
    if (!live) return;
    if (slot === active) {
      begin(reason, 0);
    } else if (slot === standby) {
      // The standby failed on a text which the Worker which plays accepted, or
      // failed to start. The sound does not change, so the page hears nothing
      // of this. A second failure leaves no standby.
      standby = undefined;
      if (!slot.second) startStandby(lastGood, true);
    }
  }

  /**
   * The standby keeps the text. A standby which refuses the text, or gives no
   * answer, is replaced once. The page hears nothing of this: the sound does not
   * change, and the standby only matters when the Worker which plays fails. A
   * replacement which refuses the text stays as a standby which holds nothing,
   * and the promotion of this standby plays silence.
   */
  async function hold(slot: Slot, text: string): Promise<void> {
    if (slot.gone) return;
    slot.held = null;
    try {
      const id = ++ids;
      const reply = await ask(slot, id, { type: "hold", id, text }, HOLD_MS);
      const error = reply.type === "held" ? reply.error : undefined;
      if (error === undefined) {
        slot.held = text;
      } else if (!slot.second) {
        failed(slot, "trap", error);
      }
    } catch (error) {
      failed(slot, "trap", errorText(error));
    }
  }

  /** The Worker which plays answered `done` for the text. */
  function remember(text: string): void {
    lastGood = text;
    const slot = standby;
    if (slot !== undefined) slot.settled = slot.settled.then(() => hold(slot, text));
  }

  function startStandby(text: string | null, second = false): void {
    const { slot, layout } = spawn(second);
    standby = slot;
    slot.settled = (async () => {
      try {
        await layout;
        await ask(slot, "ready", { type: "attach", buffer, standby: true, owner: slot.id });
        if (text !== null) await hold(slot, text);
      } catch (error) {
        failed(slot, "death", errorText(error));
      }
    })();
  }

  /** The standby, after the standby holds every score sent to the standby. */
  async function standbyReady(): Promise<Slot> {
    for (;;) {
      const candidate = standby;
      if (candidate === undefined) {
        throw new Error("The engine Worker failed and no standby runs.");
      }
      await candidate.settled;
      if (!candidate.gone) return candidate;
    }
  }

  async function recover(reason: Reason, detectMs: number): Promise<void> {
    const decided = performance.now();
    const dead = active;
    end(dead, "The frame ended the Worker.");
    const blamed = inflight.size > 0;
    const refused = [...inflight.keys()];
    inflight.clear();
    const next = await standbyReady();
    // `terminate` does not wait for the Worker to stop. The hand over of the
    // producer word does wait for a turn in progress, so the dead Worker never
    // publishes after this line. The frame ends the Worker first for all three
    // reasons: a hang goes through `recover`, and a trap and a death go through
    // `failed`.
    handOver(bridge, dead.id, next.id);
    const plays = blamed && lastGood !== null && next.held === lastGood;
    if (!blamed) lastGood = null;
    standby = undefined;
    active = next;
    const id = ++ids;
    const reply = await ask(next, id, { type: "promote", id, silent: !plays });
    pulse = pulseAt(turnCount(bridge), performance.now());
    const kept = plays && reply.type === "promoted" && reply.playing;
    send({ type: "recovered", reason, kept, detectMs, promoteMs: performance.now() - decided });
    for (const refusedId of refused) {
      send({ type: "failed", id: refusedId, error: recoveryText(reason, kept) });
    }
    startStandby(lastGood);
  }

  function begin(reason: Reason, detectMs: number): void {
    if (recovering !== undefined) return;
    recovering = recover(reason, detectMs)
      .catch((error) => send({ type: "fatal", error: errorText(error) }))
      .finally(() => {
        recovering = undefined;
      });
  }

  function watch(): void {
    if (recovering !== undefined) return;
    const now = performance.now();
    const seen = look(pulse, turnCount(bridge), now, inflight.size > 0 || isPlaying(bridge));
    pulse = seen.pulse;
    if (seen.hung) begin("hang", now - seen.pulse.since);
  }

  const { slot: first, layout } = spawn(false);
  active = first;
  const { recordBytes, canonical } = (await layout) as Extract<FromWorker, { type: "layout" }>;
  buffer = new SharedArrayBuffer(bridgeBytes(recordBytes));
  bridge = openBridge(buffer, recordBytes);
  setStop(bridge, true);
  handOver(bridge, 0, first.id);
  await ask(first, "ready", { type: "attach", buffer, standby: false, owner: first.id });
  live = true;
  pulse = pulseAt(turnCount(bridge), performance.now());
  setInterval(watch, WATCH_MS);
  startStandby(null);

  return {
    buffer,
    bridge,
    recordBytes,
    canonical,
    async post(message) {
      while (recovering !== undefined) await recovering;
      if (message.type === "play") setStop(bridge, false);
      if (message.type !== "stop") inflight.set(message.id, message.text);
      active.worker.postMessage(message);
    },
  };
}
