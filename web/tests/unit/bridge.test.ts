import assert from "node:assert/strict";
import { test } from "node:test";
import { Worker } from "node:worker_threads";
import {
  audioFrame,
  bitsFloat,
  bridgeBytes,
  CONTROL,
  CONTROL_SEQ,
  controlGeneration,
  countTurn,
  enter,
  floatBits,
  handOver,
  isPlaying,
  isStopped,
  leave,
  lockRead,
  lockWrite,
  openBridge,
  P_COVERED,
  P_PLAYING,
  POSITION,
  POSITION_SEQ,
  POSITION_WORDS,
  PRODUCER,
  QUANTA,
  QUANTUM,
  RING_HEAD,
  RING_SLOTS,
  RING_TAIL,
  readPosition,
  ringCopy,
  ringFree,
  ringPending,
  ringPush,
  ringRelease,
  STOP,
  setStop,
  TELEMETRY_SEQ,
  TURNS,
  turnCount,
  wordsValue,
  writePosition,
} from "../../src/engine/bridge.ts";

const RECORD = 8;

function open() {
  return openBridge(new SharedArrayBuffer(bridgeBytes(RECORD)), RECORD);
}

function record(value: number): Uint8Array {
  return new Uint8Array(RECORD).fill(value);
}

/** Pops the first record the way the worklet does. */
function pop(bridge: ReturnType<typeof open>): number | undefined {
  const tail = Atomics.load(bridge.words, RING_TAIL);
  if (ringPending(bridge, tail) === 0) {
    return undefined;
  }
  const into = new Uint8Array(RECORD);
  ringCopy(bridge, 0, into, 0);
  ringRelease(bridge, 1);
  return into[0];
}

test("an empty ring has nothing to read and every slot free", () => {
  const bridge = open();
  assert.equal(ringFree(bridge), RING_SLOTS);
  assert.equal(pop(bridge), undefined);
});

test("the ring returns records in order and wraps", () => {
  const bridge = open();
  for (let count = 0; count < RING_SLOTS * 3; count += 1) {
    assert.ok(ringPush(bridge, record(count % 251)));
    assert.equal(pop(bridge), count % 251);
  }
  assert.equal(ringFree(bridge), RING_SLOTS);
});

test("a full ring refuses a push until the consumer frees a slot", () => {
  const bridge = open();
  for (let count = 0; count < RING_SLOTS; count += 1) {
    assert.ok(ringPush(bridge, record(1)));
  }
  assert.equal(ringFree(bridge), 0);
  assert.equal(ringPush(bridge, record(2)), false);
  assert.equal(pop(bridge), 1);
  assert.ok(ringPush(bridge, record(2)));
});

test("the ring counts across the 32 bit wrap", () => {
  const bridge = open();
  Atomics.store(bridge.words, RING_TAIL, 0x7fff_ffff);
  Atomics.store(bridge.words, RING_HEAD, 0x7fff_ffff);
  assert.ok(ringPush(bridge, record(7)));
  assert.ok(ringPush(bridge, record(8)));
  assert.equal(pop(bridge), 7);
  assert.equal(pop(bridge), 8);
});

test("a sequence lock gives a whole block", () => {
  const bridge = open();
  const into = new Int32Array(4);
  lockWrite(bridge.words, CONTROL_SEQ, CONTROL, [1, 2, 3, 4]);
  assert.ok(lockRead(bridge.words, CONTROL_SEQ, CONTROL, into));
  assert.deepEqual([...into], [1, 2, 3, 4]);
});

test("a sequence lock refuses a copy while the writer works", () => {
  const bridge = open();
  const into = new Int32Array(4);
  Atomics.add(bridge.words, CONTROL_SEQ, 1);
  assert.equal(lockRead(bridge.words, CONTROL_SEQ, CONTROL, into), false);
  Atomics.add(bridge.words, CONTROL_SEQ, 1);
  assert.ok(lockRead(bridge.words, CONTROL_SEQ, CONTROL, into));
});

test("floats cross the buffer as bits", () => {
  assert.equal(bitsFloat(floatBits(0.5)), 0.5);
  assert.equal(bitsFloat(floatBits(0)), 0);
});

test("the audio frame is the quantum count times 128", () => {
  const bridge = open();
  Atomics.store(bridge.words, QUANTA, 3);
  assert.equal(audioFrame(bridge), 3 * QUANTUM);
});

/** The words of a position, each one different. */
function position(): Int32Array {
  return Int32Array.from({ length: POSITION_WORDS }, (_, index) => index * 3 - 7);
}

test("the position is a whole block", () => {
  const bridge = open();
  const into = new Int32Array(POSITION_WORDS);
  writePosition(bridge, position());
  assert.ok(readPosition(bridge, into));
  assert.deepEqual([...into], [...position()]);
});

test("a position copy is refused while the writer works", () => {
  const bridge = open();
  const into = new Int32Array(POSITION_WORDS);
  writePosition(bridge, position());
  Atomics.add(bridge.words, POSITION_SEQ, 1);
  assert.equal(readPosition(bridge, into), false);
  Atomics.add(bridge.words, POSITION_SEQ, 1);
  assert.ok(readPosition(bridge, into));
});

test("a position copy is refused when the writer wrote during the copy", () => {
  const bridge = open();
  writePosition(bridge, position());
  // The writer writes again after the reader copied its third word.
  const target = new Int32Array(POSITION_WORDS);
  const into = new Proxy(target, {
    set(array, key, value) {
      Reflect.set(array, key, value);
      if (key === "2") writePosition(bridge, new Int32Array(POSITION_WORDS).fill(5));
      return true;
    },
    get: (array, key) => Reflect.get(array, key),
  });
  assert.equal(readPosition(bridge, into), false);
  // The next copy is whole and holds the new words.
  assert.ok(readPosition(bridge, target));
  assert.deepEqual([...target], new Array(POSITION_WORDS).fill(5));
});

test("the position and the turn count sit in a line of the Worker alone", () => {
  const line = (word: number) => Math.floor(word / 16);
  assert.equal(line(POSITION_SEQ), line(TURNS));
  assert.equal(line(POSITION + POSITION_WORDS - 1), line(POSITION_SEQ));
  // The lines of the control block, the stop word and the worklet words are other lines.
  for (const other of [CONTROL_SEQ, RING_TAIL, STOP, RING_HEAD, QUANTA, TELEMETRY_SEQ]) {
    assert.notEqual(line(other), line(POSITION_SEQ));
  }
  assert.equal(bridgeBytes(8), 80 * 4 + RING_SLOTS * 8);
});

test("a 64 bit word of the position reads as a number", () => {
  const words = Int32Array.from([5, 2]);
  assert.equal(wordsValue(words, 0), 2 * 2 ** 32 + 5);
  assert.equal(wordsValue(Int32Array.from([-1, 0]), 0), 2 ** 32 - 1);
});

test("the playing flag and the covered frame come from the position", () => {
  const bridge = open();
  assert.equal(isPlaying(bridge), false);
  const words = position();
  words[P_PLAYING] = 1;
  words[P_COVERED] = 96_000;
  words[P_COVERED + 1] = 0;
  writePosition(bridge, words);
  assert.equal(isPlaying(bridge), true);
  const into = new Int32Array(POSITION_WORDS);
  assert.ok(readPosition(bridge, into));
  assert.equal(wordsValue(into, P_COVERED), 96_000);
});

test("the turn count counts and wraps at 32 bits", () => {
  const bridge = open();
  assert.equal(turnCount(bridge), 0);
  countTurn(bridge);
  countTurn(bridge);
  assert.equal(turnCount(bridge), 2);
  Atomics.store(bridge.words, TURNS, -1);
  assert.equal(turnCount(bridge), 0xffff_ffff);
  countTurn(bridge);
  assert.equal(turnCount(bridge), 0);
});

test("the frame page reads the stop word and the generation", () => {
  const bridge = open();
  assert.equal(isStopped(bridge), false);
  setStop(bridge, true);
  assert.equal(isStopped(bridge), true);
  lockWrite(bridge.words, CONTROL_SEQ, CONTROL, [7, 0, 0, 0, 0, 0, 0, 0]);
  assert.equal(controlGeneration(bridge), 7);
});

test("the producer word names the Worker allowed to publish", () => {
  const bridge = open();
  assert.equal(enter(bridge, 1), false);
  assert.ok(handOver(bridge, 0, 1));
  assert.ok(enter(bridge, 1));
  leave(bridge, 1);
  assert.ok(enter(bridge, 1));
  leave(bridge, 1);
  // The frame hands the word to the next Worker. The old Worker never publishes again.
  assert.ok(handOver(bridge, 1, 2));
  assert.equal(enter(bridge, 1), false);
  assert.ok(enter(bridge, 2));
  leave(bridge, 2);
});

test("a hand over takes the word from a Worker which was ended in the middle of a publish", () => {
  const bridge = open();
  handOver(bridge, 0, 1);
  assert.ok(enter(bridge, 1));
  // The Worker was ended with both sequence words odd. The words are whole again.
  Atomics.add(bridge.words, CONTROL_SEQ, 1);
  Atomics.add(bridge.words, POSITION_SEQ, 1);
  assert.equal(handOver(bridge, 1, 2, 100), false);
  assert.equal(Atomics.load(bridge.words, PRODUCER), 2);
  assert.equal(Atomics.load(bridge.words, CONTROL_SEQ) % 2, 0);
  assert.equal(Atomics.load(bridge.words, POSITION_SEQ) % 2, 0);
  assert.equal(enter(bridge, 1), false);
  assert.ok(enter(bridge, 2));
});

test("a hand over waits for a publish in progress", async () => {
  const buffer = new SharedArrayBuffer(bridgeBytes(RECORD));
  const bridge = openBridge(buffer, RECORD);
  handOver(bridge, 0, 1);
  // A thread enters for 3 ms, as a Worker does in the middle of a turn.
  const thread = new Worker(
    `const { workerData: { buffer, producer, flag } } = require("node:worker_threads");
     const words = new Int32Array(buffer);
     Atomics.compareExchange(words, producer, 1, 1 | 0x40000000);
     Atomics.store(words, flag, 1);
     const until = Date.now() + 3;
     while (Date.now() < until);
     Atomics.compareExchange(words, producer, 1 | 0x40000000, 1);`,
    { eval: true, workerData: { buffer, producer: PRODUCER, flag: 63 } },
  );
  while (Atomics.load(bridge.words, 63) === 0);
  const began = Date.now();
  assert.equal(handOver(bridge, 1, 2), true);
  assert.ok(Date.now() - began >= 1, "the hand over waited");
  assert.equal(enter(bridge, 1), false);
  await new Promise((resolve) => thread.once("exit", resolve));
});
