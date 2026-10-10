// The Worker around the engine module and the score host. At start, in this
// order: the policy proof, the lockdown, then the modules. A score is the text
// of the pattern language. The Worker transpiles the text, evaluates the result
// inside the lockdown and gives the pattern to the engine. Every 10 ms a turn
// queries the pattern, publishes the control words and the position, moves the
// event records into the ring and counts the turn. The module reads no clock:
// the frame of each call comes from the quantum count the worklet keeps.
//
// The frame starts two Workers. The first one plays. The second one is the
// standby. The standby evaluates the last good score, makes no turn and writes
// nothing into the bridge. When the first Worker hangs, traps or dies, the frame
// ends the first Worker and promotes the standby. The standby reads the
// position, continues the music from the position, and starts its own turns.
//
// Score text is code from anywhere. The lockdown removes every global name
// which the allowlist lacks. The glue takes the names the Worker needs when
// this file loads, and the code below the capture lines looks up no such name.

import type { FromFrame, Position, ToFrame } from "../protocol.ts";
import {
  audioFrame,
  type Bridge,
  CONTROL,
  CONTROL_SEQ,
  CONTROL_WORDS,
  countTurn,
  enter,
  isStopped,
  leave,
  lockWrite,
  openBridge,
  P_PLAYING,
  POSITION_WORDS,
  readPosition,
  ringFree,
  ringPush,
  writePosition,
} from "./bridge.ts";
import { createEvaluator, type Outcome, type Player } from "./evaluate.ts";
import type { PatternObject } from "./score/binding.ts";
import { ALLOWED_GLOBALS, lockdown, requireLockdown } from "./score/lockdown.ts";
import { openScoreHost } from "./score/score.ts";
import { createTranspiler } from "./transpiler.ts";

/** Milliseconds between two turns. */
const TURN_MS = 10;
/** Reads of the position before the standby gives up. A read fails while the writer is in the middle of a write. */
const READ_TRIES = 100;
/** A module which the policy of the Worker must refuse to load. */
const PROBE = "data:text/javascript,export default 0";
const NO_POLICY =
  "The engine Worker has no content security policy of its own, so the Worker refuses every score. Send the policy header with worker.js.";

/** What the frame sends to the Worker. */
export type ToWorker =
  | { type: "init"; engine: WebAssembly.Module; transpiler: WebAssembly.Module; sampleRate: number }
  /** A standby makes no turn until the frame promotes the standby. */
  | { type: "attach"; buffer: SharedArrayBuffer; standby: boolean; owner: number }
  /** The standby evaluates the text and keeps the score. */
  | { type: "hold"; id: number; text: string }
  /** The standby takes over. A silent promotion plays no score. */
  | { type: "promote"; id: number; silent: boolean }
  | Exclude<ToFrame, { type: "allocations" }>;
/** What the Worker answers. */
export type FromWorker =
  | { type: "layout"; recordBytes: number; canonical: Uint8Array }
  | { type: "ready" }
  /** The text is kept, or the error says why not. */
  | { type: "held"; id: number; error?: string }
  /** The standby plays. `playing` is false when the position or the stop word says the sound is stopped. */
  | { type: "promoted"; id: number; playing: boolean }
  | Extract<FromFrame, { type: "done" | "failed" | "fatal" }>;

interface EngineExports {
  memory: WebAssembly.Memory;
  engine_init(sampleRate: number): number;
  engine_set_score(handle: number, frame: number): number;
  engine_set_cps(cps: number, frame: number): void;
  engine_play(frame: number): void;
  engine_stop(): void;
  engine_turn(frame: number, freeRecords: number): number;
  engine_canonical_event(): number;
  engine_position(): void;
  engine_adopt(frame: number): number;
}

/** Where the module keeps its areas, as `engine_init` returns them. The
 * layout holds ten u32 fields. */
interface Layout {
  error: number;
  /** Address of the word which holds the length of the error message. */
  errorLength: number;
  records: number;
  recordBytes: number;
  control: number;
  /** Address of the position block, `POSITION_WORDS` words. */
  position: number;
}

// Captured when this file loads, before the lockdown removes the names.
const scope = globalThis;
const post = postMessage.bind(scope);
const every = setInterval.bind(scope);
const stopEvery = clearInterval.bind(scope);
const decoder = new TextDecoder();

let engine: EngineExports;
let layout: Layout;
let bridge: Bridge;
/** The number of this Worker in the producer word of the bridge. */
let owner = 0;
let evaluator: ReturnType<typeof createEvaluator>;
/** The pattern of an empty score. */
let silence: PatternObject;
/** The timer of the turns, or undefined while the Worker makes none. */
let turning: ReturnType<typeof every> | undefined;
/** True when the policy proof passed. */
let policy = false;
/** Counts the stop messages. A play which a stop overtakes does not start. */
let stops = 0;

function send(message: FromWorker): void {
  post(message);
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** One import of a `data:` module must fail. A Worker script which came with no
 * policy header runs with no policy, and then the import works. */
async function policyHolds(): Promise<boolean> {
  try {
    await import(PROBE);
    return false;
  } catch {
    return true;
  }
}

// The proof comes first, then the lockdown. The lockdown runs also after a
// failed proof, so the Worker has one state to reason about.
const secured = (async () => {
  policy = await policyHolds();
  try {
    lockdown(scope, ALLOWED_GLOBALS);
  } catch {
    // `requireLockdown` refuses every score.
  }
})();

/** The reason the Worker refuses every score, or null. */
function refusal(): string | null {
  if (!policy) return NO_POLICY;
  try {
    requireLockdown(scope);
    return null;
  } catch (error) {
    return errorText(error);
  }
}

// The module memory grows during a call, so every view is made fresh.
function bytesAt(address: number, length: number): Uint8Array {
  return new Uint8Array(engine.memory.buffer, address, length);
}

/** The message of the last refusal of the engine. */
function engineError(): string {
  const length = new Uint32Array(engine.memory.buffer, layout.errorLength, 1)[0];
  return decoder.decode(bytesAt(layout.error, length));
}

const player: Player = {
  setCps: (cps, frame) => engine.engine_set_cps(cps, frame),
  setScore: (handle, frame) => (engine.engine_set_score(handle, frame) >= 0 ? null : engineError()),
};

async function init(message: Extract<ToWorker, { type: "init" }>): Promise<void> {
  await secured;
  // The engine instance of the binding is the instance the scheduler turns.
  const host = await openScoreHost(message.engine);
  silence = host.surface.scope.silence as PatternObject;
  engine = host.binding.exports as unknown as EngineExports;
  const address = engine.engine_init(message.sampleRate);
  if (address === 0) {
    throw new Error("the engine refused the sample rate");
  }
  const fields = new Uint32Array(engine.memory.buffer, address, 10);
  layout = {
    error: fields[2],
    errorLength: address + 3 * 4,
    records: fields[4],
    recordBytes: fields[5],
    control: fields[7],
    position: fields[9],
  };
  evaluator = createEvaluator({
    transpiler: createTranspiler(message.transpiler),
    host,
    player,
    frame: () => audioFrame(bridge),
  });
  const canonical = bytesAt(engine.engine_canonical_event(), layout.recordBytes).slice();
  send({ type: "layout", recordBytes: layout.recordBytes, canonical });
}

/** The generation in the control words of the last turn. */
function generation(): number {
  return new Uint32Array(engine.memory.buffer, layout.control, 1)[0];
}

/** One turn: query, publish the control words and the position, move the
 * records, then count the turn. A turn which hangs or traps is never counted.
 * The frame hands the right to publish to the standby while this Worker
 * still runs. This Worker then publishes nothing and makes no more turns. */
function turn(): void {
  const count = engine.engine_turn(audioFrame(bridge), ringFree(bridge));
  if (!enter(bridge, owner)) {
    stopTurns();
    return;
  }
  try {
    const control = new Uint32Array(engine.memory.buffer, layout.control, CONTROL_WORDS);
    lockWrite(bridge.words, CONTROL_SEQ, CONTROL, control);
    engine.engine_position();
    writePosition(bridge, new Uint32Array(engine.memory.buffer, layout.position, POSITION_WORDS));
    const size = layout.recordBytes;
    const records = bytesAt(layout.records, count * size);
    for (let index = 0; index < count; index += 1) {
      if (!ringPush(bridge, records.subarray(index * size, (index + 1) * size))) {
        throw new Error("the ring overflowed");
      }
    }
    countTurn(bridge);
  } finally {
    leave(bridge, owner);
  }
}

/** Starts the timer of the turns. An exception out of a turn is a trap or a
 * fault of the glue: the Worker makes no more turns and says so. */
function startTurns(): void {
  turning = every(() => {
    try {
      turn();
    } catch (error) {
      stopTurns();
      send({ type: "fatal", error: errorText(error) });
    }
  }, TURN_MS);
}

function stopTurns(): void {
  if (turning !== undefined) stopEvery(turning);
  turning = undefined;
}

function fail(id: number, error: string, position?: Position): void {
  send({ type: "failed", id, error, position });
}

/** Evaluates the score of a message. A play starts the pattern after the score
 * ran. A score which fails changes nothing, and the sound goes on. */
async function evaluate(message: Extract<ToWorker, { type: "play" | "set" }>): Promise<void> {
  const reason = refusal();
  if (reason !== null) {
    fail(message.id, reason);
    return;
  }
  const before = stops;
  const outcome = await evaluator(message.text);
  if (!outcome.ok) {
    fail(message.id, outcome.error, outcome.position);
    return;
  }
  if (message.type === "play") {
    if (stops !== before) {
      fail(message.id, "The sound was stopped while the score ran.");
      return;
    }
    engine.engine_play(audioFrame(bridge));
  }
  turn();
  send({ type: "done", id: message.id, generation: generation() });
}

/** The standby evaluates the last good score and keeps the score. The
 * standby makes no turn and writes nothing into the bridge. */
async function hold(message: Extract<ToWorker, { type: "hold" }>): Promise<void> {
  const reason = refusal();
  const outcome: Outcome =
    reason === null ? await evaluator(message.text) : { ok: false, error: reason };
  send({ type: "held", id: message.id, error: outcome.ok ? undefined : outcome.error });
}

/**
 * The standby takes over from the Worker which is gone: the standby reads the
 * position from the bridge, continues the music from the position and starts
 * its own turns. The
 * stop word of the frame wins over the position, so a stop which came while the
 * first Worker hung stays a stop. A torn position throws, and the Worker
 * answers `fatal`.
 */
function promote(message: Extract<ToWorker, { type: "promote" }>): void {
  const frame = audioFrame(bridge);
  if (message.silent) engine.engine_set_score(silence.handle, frame);
  const words = new Int32Array(POSITION_WORDS);
  let whole = false;
  for (let tries = 0; tries < READ_TRIES && !whole; tries += 1) {
    whole = readPosition(bridge, words);
  }
  if (!whole) throw new Error("the position is not whole");
  if (isStopped(bridge)) words[P_PLAYING] = 0;
  new Uint32Array(engine.memory.buffer, layout.position, POSITION_WORDS).set(words);
  if (engine.engine_adopt(frame) < 0) throw new Error(engineError());
  startTurns();
  turn();
  send({ type: "promoted", id: message.id, playing: words[P_PLAYING] !== 0 });
}

async function handle(message: ToWorker): Promise<void> {
  switch (message.type) {
    case "init":
      await init(message);
      break;
    case "attach":
      bridge = openBridge(message.buffer, layout.recordBytes);
      owner = message.owner;
      if (!message.standby) startTurns();
      send({ type: "ready" });
      break;
    case "hold":
      await hold(message);
      break;
    case "promote":
      promote(message);
      break;
    case "set":
    case "play":
      await evaluate(message);
      break;
  }
}

// A score runs as long as the score needs, so the messages wait in line: two
// scores never run at once. A stop does not wait, and a score which never ends
// does not hold a stop back. The stop word of the frame silences the sound before
// the stop message arrives, and the frame answers the stop itself.
let line: Promise<void> = Promise.resolve();

addEventListener("message", (event: MessageEvent<ToWorker>) => {
  const message = event.data;
  if (message.type === "stop") {
    stops += 1;
    engine.engine_stop();
    return;
  }
  // An exception out of the glue or a trap of the engine ends the turns, and
  // the frame replaces this Worker.
  line = line
    .then(() => handle(message))
    .catch((error) => {
      stopTurns();
      send({ type: "fatal", error: errorText(error) });
    });
});
