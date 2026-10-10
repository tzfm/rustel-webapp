// The engine frame owns the AudioContext, the worklet node, the Workers and the
// bridge, and relays messages from the app page. The frame answers only
// the app origin. The buffer never leaves the frame. `pair.ts` holds the Worker
// which plays and the standby.

import type { FromFrame, Telemetry, ToFrame } from "../protocol.ts";
import {
  type Bridge,
  bitsFloat,
  controlGeneration,
  lockRead,
  P_COVERED,
  P_PLAYING,
  POSITION_WORDS,
  QUANTUM,
  readPosition,
  setStop,
  T_ACCEPTED,
  T_FLUSHED,
  T_GENERATION,
  T_LATE,
  T_PEAK,
  T_QUANTA,
  T_REFUSED,
  T_RING_REFUSED,
  T_ROLE_CONFLICTS,
  T_STALE,
  TELEMETRY,
  TELEMETRY_SEQ,
  TELEMETRY_WORDS,
  wordsValue,
} from "./bridge.ts";
import { type Opened, openPair } from "./pair.ts";
import type { FromWorklet, ToWorklet, WorkletOptions } from "./worklet.ts";

const APP_ORIGIN = __APP_ORIGIN__;

interface Session {
  context: AudioContext;
  pair: Opened;
  node: AudioWorkletNode;
  bridge: Bridge;
}

/** Scratch space for the pump, so the pump makes no new array for each frame. */
interface Scratch {
  telemetry: Int32Array;
  position: Int32Array;
  /** The last whole reading of the position, in frames. */
  ahead: number;
}

interface Started {
  context: AudioContext;
  ready: Promise<Session>;
}

let started: Started | undefined;

// The modules compile while the page loads, so the first play finds them ready.
const modules = Promise.all([
  compile("engine.wasm"),
  compile("dsp.wasm"),
  compile("transpiler.wasm"),
]);
modules.catch(() => undefined);

function compile(name: string): Promise<WebAssembly.Module> {
  return WebAssembly.compileStreaming(fetch(new URL(name, import.meta.url)));
}

function send(message: FromFrame): void {
  parent.postMessage(message, APP_ORIGIN);
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Resolves with the next message of `type` from a port. */
function next<T extends { type: string }>(target: MessagePort, type: string): Promise<T> {
  return new Promise((resolve) => {
    const listener = (event: Event) => {
      const data = (event as MessageEvent<T>).data;
      if (data.type === type) {
        target.removeEventListener("message", listener);
        resolve(data);
      }
    };
    target.addEventListener("message", listener);
  });
}

async function bringUp(context: AudioContext): Promise<Session> {
  if (!crossOriginIsolated) {
    throw new Error(
      "The engine frame is not cross-origin isolated. Check the COOP and COEP headers.",
    );
  }
  const [engineModule, dspModule, transpilerModule] = await modules;

  const pair = await openPair({
    engine: engineModule,
    transpiler: transpilerModule,
    sampleRate: context.sampleRate,
    send,
  });
  const { buffer, bridge, recordBytes, canonical } = pair;

  await context.audioWorklet.addModule(new URL("worklet.js", import.meta.url));
  const options: WorkletOptions = { module: dspModule, buffer, recordBytes };
  const node = new AudioWorkletNode(context, "renderer", {
    numberOfInputs: 0,
    numberOfOutputs: 1,
    outputChannelCount: [2],
    processorOptions: options,
  });
  node.onprocessorerror = () => send({ type: "fatal", error: "The renderer stopped." });
  node.port.start();
  const verdict = next<Extract<FromWorklet, { type: "canonical" }>>(node.port, "canonical");
  node.port.postMessage({ type: "canonical", bytes: canonical } satisfies ToWorklet);
  if (!(await verdict).ok) {
    throw new Error(
      "The engine module and the renderer module disagree on the event layout. Build both from one source.",
    );
  }
  node.connect(context.destination);

  const session = { context, pair, node, bridge };
  pump(session, {
    telemetry: new Int32Array(TELEMETRY_WORDS),
    position: new Int32Array(POSITION_WORDS),
    ahead: 0,
  });
  return session;
}

function start(): Started {
  if (started === undefined) {
    const context = new AudioContext();
    const ready = bringUp(context);
    ready.catch((error) => send({ type: "fatal", error: errorText(error) }));
    started = { context, ready };
  }
  return started;
}

async function allocations(node: AudioWorkletNode): Promise<number> {
  const answer = next<Extract<FromWorklet, { type: "allocations" }>>(node.port, "allocations");
  node.port.postMessage({ type: "allocations" } satisfies ToWorklet);
  return (await answer).count;
}

async function handle(message: ToFrame): Promise<void> {
  try {
    const { context, ready } = start();
    if (message.type === "play") {
      // Resume while the click of the app page is still the active gesture.
      void context.resume();
    }
    const session = await ready;
    switch (message.type) {
      case "play":
      case "set":
        await session.pair.post(message);
        break;
      case "stop":
        // The frame writes the stop word and answers itself, in every state of
        // the Workers, so a busy Worker cannot delay the stop.
        setStop(session.bridge, true);
        send({ type: "done", id: message.id, generation: controlGeneration(session.bridge) });
        await session.pair.post(message);
        break;
      case "allocations":
        send({ type: "allocations", id: message.id, count: await allocations(session.node) });
        break;
    }
  } catch (error) {
    send({ type: "failed", id: message.id, error: errorText(error) });
  }
}

function telemetry(words: Int32Array, context: AudioContext, ahead: number): Telemetry {
  return {
    type: "telemetry",
    isolated: crossOriginIsolated,
    audio: context.state,
    sampleRate: context.sampleRate,
    frame: (words[T_QUANTA] >>> 0) * QUANTUM,
    generation: words[T_GENERATION] >>> 0,
    accepted: words[T_ACCEPTED] >>> 0,
    stale: words[T_STALE] >>> 0,
    refused: words[T_REFUSED] >>> 0,
    late: words[T_LATE] >>> 0,
    ringRefused: words[T_RING_REFUSED] >>> 0,
    roleConflicts: words[T_ROLE_CONFLICTS] >>> 0,
    flushed: words[T_FLUSHED] >>> 0,
    peak: bitsFloat(words[T_PEAK]),
    ahead,
  };
}

/** Sends one telemetry object for each animation frame. A copy which is not
 * whole waits for the next frame. */
function pump(session: Session, scratch: Scratch): void {
  if (lockRead(session.bridge.words, TELEMETRY_SEQ, TELEMETRY, scratch.telemetry)) {
    const frame = (scratch.telemetry[T_QUANTA] >>> 0) * QUANTUM;
    // The covered frame of the position, less the audio frame.
    if (readPosition(session.bridge, scratch.position)) {
      const covered = wordsValue(scratch.position, P_COVERED);
      scratch.ahead = scratch.position[P_PLAYING] === 0 ? 0 : Math.max(0, covered - frame);
    }
    send(telemetry(scratch.telemetry, session.context, scratch.ahead));
  }
  requestAnimationFrame(() => pump(session, scratch));
}

addEventListener("message", (event: MessageEvent<ToFrame>) => {
  if (event.origin === APP_ORIGIN && event.source === parent) {
    void handle(event.data);
  }
});
