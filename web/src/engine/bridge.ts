// The one SharedArrayBuffer between the Worker and the AudioWorklet.
//
//   +-------------------------+------------------------------------------+
//   | header, 80 words        | event ring: 512 records of recordBytes   |
//   +-------------------------+------------------------------------------+
//
// The header has one line of 16 words for each writer, so two threads never
// write the same cache line.
//
//   words  0..15  Worker      control sequence, 8 control words, ring tail
//   words 16..31  frame page  stop word, producer word
//   words 32..47  worklet     ring head, quantum count
//   words 48..63  worklet     telemetry sequence, 10 telemetry words
//   words 64..79  Worker      position sequence, turn count, 13 position words
//
// Order rule: the Worker publishes control words, then moves the ring tail
// past the records of their generation. The worklet reads the tail, then takes
// the control snapshot. A record never meets control words older than its
// generation.
//
// The producer word names the one Worker allowed to publish. A Worker holds the
// word as its number plus a busy flag while the Worker writes the control words,
// the position, the records and the turn count of one turn, and a Worker whose
// number is not in the word publishes nothing. The frame page ends a Worker
// before the standby takes over, but `terminate` does not wait for the Worker
// to stop. The hand over of the word does wait for a publish in progress, so the
// old Worker and the new one never write the ring at the same time.
//
// The position line has other readers than the control line: the frame page
// reads the turn count and the position every 20 ms, and a standby Worker reads
// the position once, when the Worker which plays is gone. The Worker writes
// the position after the control words and before the records of the turn, so a
// reader never sees a position behind the control words of the same turn.

// Captured when the module loads. The lockdown of the score Worker removes
// `Atomics` from the global object before a score runs, and the glue must not
// look up a name on the global object after the lockdown.
const Atom = Atomics;

/** Frames of one render call. */
export const QUANTUM = 128;
/** Slots of the event ring. A power of two. */
export const RING_SLOTS = 512;

/** Control block: sequence word, then generation, takeover frame, takeover cut
 * and line arm as a low word and a high word each. */
export const CONTROL_SEQ = 0;
export const CONTROL = 1;
export const CONTROL_WORDS = 8;
/** Records the Worker has written, counted without end and wrapped to 32 bits. */
export const RING_TAIL = 9;
/** 1 stops the sound, 0 lets the renderer play. */
export const STOP = 16;
/** The number of the one Worker allowed to publish, or 0 for none. */
export const PRODUCER = 17;
/** Added to the producer word while the Worker publishes. */
const BUSY = 0x4000_0000;
/** Tries of a hand over for a publish in progress, which takes microseconds. */
const HAND_SPINS = 1_000_000;
/** Records the worklet has read, counted as the tail. */
export const RING_HEAD = 32;
/** Quanta rendered. The Worker reads the audio frame from this word alone. */
export const QUANTA = 33;
export const TELEMETRY_SEQ = 48;
export const TELEMETRY = 49;
export const TELEMETRY_WORDS = 10;
/** Turns the Worker has made, counted without end and wrapped to 32 bits. The frame page watches this word. */
export const TURNS = 65;
export const POSITION_SEQ = 64;
export const POSITION = 66;
/** Words of the position the engine module publishes. The size matches `POSITION_WORDS` of the module. */
export const POSITION_WORDS = 13;

// Position word indexes, from the start of the position block. A 64-bit value
// takes its low word first. The generation is the one the control words carry.
// The covered frame is the first frame, on the audio clock, whose events are not
// all in the ring. The playing flag is 1 while the engine plays. Two words
// follow: the events the renderer holds at the last turn, and the low 32 bits of
// the frame of the last turn.
export const P_GENERATION = 0;
export const P_COVERED = 2;
export const P_PLAYING = 10;

// Telemetry word indexes. Words 1 to 8 copy the renderer module telemetry
// words 0 to 7 in the same order.
export const T_QUANTA = 0;
export const T_ACCEPTED = 1;
export const T_STALE = 2;
export const T_REFUSED = 3;
export const T_LATE = 4;
export const T_RING_REFUSED = 5;
export const T_ROLE_CONFLICTS = 6;
export const T_FLUSHED = 7;
export const T_GENERATION = 8;
/** Highest absolute output sample of the last blocks, as float32 bits. */
export const T_PEAK = 9;

const HEADER_WORDS = 80;
const HEADER_BYTES = HEADER_WORDS * 4;

/** The views of one buffer. Each thread makes this once. */
export interface Bridge {
  words: Int32Array;
  /** One view for each ring slot, so a copy makes no new view. */
  slots: Uint8Array[];
  recordBytes: number;
}

/** Bytes of a buffer for records of `recordBytes` each. */
export function bridgeBytes(recordBytes: number): number {
  return HEADER_BYTES + RING_SLOTS * recordBytes;
}

export function openBridge(buffer: SharedArrayBuffer, recordBytes: number): Bridge {
  if (buffer.byteLength < bridgeBytes(recordBytes)) {
    throw new RangeError("the buffer is too small for the ring");
  }
  const slots: Uint8Array[] = [];
  for (let slot = 0; slot < RING_SLOTS; slot += 1) {
    slots.push(new Uint8Array(buffer, HEADER_BYTES + slot * recordBytes, recordBytes));
  }
  return { words: new Int32Array(buffer, 0, HEADER_WORDS), slots, recordBytes };
}

/** Writes the stop word. Safe from any thread, also while the Worker is busy. */
export function setStop(bridge: Bridge, stopped: boolean): void {
  Atom.store(bridge.words, STOP, stopped ? 1 : 0);
}

/** The low word of the generation in the control block. */
export function controlGeneration(bridge: Bridge): number {
  return Atom.load(bridge.words, CONTROL) >>> 0;
}

/** Worker side: takes the right to publish one turn. False when the producer word names another Worker. */
export function enter(bridge: Bridge, owner: number): boolean {
  return Atom.compareExchange(bridge.words, PRODUCER, owner, owner | BUSY) === owner;
}

/** Worker side: ends a publish. Changes nothing when the frame took the word meanwhile. */
export function leave(bridge: Bridge, owner: number): void {
  Atom.compareExchange(bridge.words, PRODUCER, owner | BUSY, owner);
}

/**
 * Frame side: gives the right to publish from the Worker `from` to the Worker
 * `to`. Waits while `from` publishes. Returns false when `from` never left: the
 * frame ended the Worker in the middle of a publish. The frame then takes the
 * word, and makes the two sequence words whole again, since a sequence word the
 * ended Worker left odd would refuse every read.
 */
export function handOver(bridge: Bridge, from: number, to: number, spins = HAND_SPINS): boolean {
  for (let spin = 0; spin < spins; spin += 1) {
    if (Atom.compareExchange(bridge.words, PRODUCER, from, to) === from) return true;
  }
  Atom.store(bridge.words, PRODUCER, to);
  for (const sequence of [CONTROL_SEQ, POSITION_SEQ]) {
    if ((Atom.load(bridge.words, sequence) & 1) !== 0) Atom.add(bridge.words, sequence, 1);
  }
  return false;
}

/** True while the stop word is 1. */
export function isStopped(bridge: Bridge): boolean {
  return Atom.load(bridge.words, STOP) !== 0;
}

/** The audio frame of the next quantum. Frames count from the first quantum. */
export function audioFrame(bridge: Bridge): number {
  return (Atom.load(bridge.words, QUANTA) >>> 0) * QUANTUM;
}

// The ring has one producer, the Worker, and one consumer, the worklet. Head
// and tail count without end. A slot is `count & (RING_SLOTS - 1)`.

/** Slots the producer is free to fill. */
export function ringFree(bridge: Bridge): number {
  const used = (Atom.load(bridge.words, RING_TAIL) - Atom.load(bridge.words, RING_HEAD)) | 0;
  return RING_SLOTS - used;
}

/** Copies one record into the ring. Returns false when the ring is full. */
export function ringPush(bridge: Bridge, record: Uint8Array): boolean {
  if (ringFree(bridge) === 0) {
    return false;
  }
  const tail = Atom.load(bridge.words, RING_TAIL);
  bridge.slots[tail & (RING_SLOTS - 1)].set(record);
  Atom.store(bridge.words, RING_TAIL, (tail + 1) | 0);
  return true;
}

/** Records between the head and a tail the consumer loaded earlier. */
export function ringPending(bridge: Bridge, tail: number): number {
  return (tail - Atom.load(bridge.words, RING_HEAD)) | 0;
}

/** Copies the record `index` places after the head into `into` at `at`. */
export function ringCopy(bridge: Bridge, index: number, into: Uint8Array, at: number): void {
  const head = Atom.load(bridge.words, RING_HEAD);
  into.set(bridge.slots[(head + index) & (RING_SLOTS - 1)], at);
}

/** Frees the first `count` records after the consumer copied them. */
export function ringRelease(bridge: Bridge, count: number): void {
  const head = Atom.load(bridge.words, RING_HEAD);
  Atom.store(bridge.words, RING_HEAD, (head + count) | 0);
}

// A sequence lock guards a block of words with one writer. The sequence word
// is odd while the writer works. A reader keeps a copy only when the sequence
// was even before the copy and did not change during the copy.

export function lockWrite(
  words: Int32Array,
  sequence: number,
  at: number,
  source: ArrayLike<number>,
): void {
  Atom.add(words, sequence, 1);
  for (let index = 0; index < source.length; index += 1) {
    Atom.store(words, at + index, source[index] | 0);
  }
  Atom.add(words, sequence, 1);
}

/** Fills `into` with the block. Returns false when the copy is not whole. */
export function lockRead(
  words: Int32Array,
  sequence: number,
  at: number,
  into: Int32Array,
): boolean {
  const before = Atom.load(words, sequence);
  if ((before & 1) !== 0) {
    return false;
  }
  for (let index = 0; index < into.length; index += 1) {
    into[index] = Atom.load(words, at + index);
  }
  return Atom.load(words, sequence) === before;
}

/** True while the position says the engine plays. */
export function isPlaying(bridge: Bridge): boolean {
  return Atom.load(bridge.words, POSITION + P_PLAYING) !== 0;
}

/** The 64-bit value at `at` in a copy of the position or the control block. */
export function wordsValue(words: ArrayLike<number>, at: number): number {
  return (words[at + 1] >>> 0) * 2 ** 32 + (words[at] >>> 0);
}

/** Counts one turn of the Worker. Only the Worker which plays calls this, after the turn is whole. */
export function countTurn(bridge: Bridge): void {
  Atom.add(bridge.words, TURNS, 1);
}

/** The turns counted so far, wrapped to 32 bits. */
export function turnCount(bridge: Bridge): number {
  return Atom.load(bridge.words, TURNS) >>> 0;
}

/** Publishes the position of the engine. Only the Worker which plays calls this. */
export function writePosition(bridge: Bridge, words: ArrayLike<number>): void {
  lockWrite(bridge.words, POSITION_SEQ, POSITION, words);
}

/** Fills `into` with the position. Returns false when the copy is not whole. */
export function readPosition(bridge: Bridge, into: Int32Array): boolean {
  return lockRead(bridge.words, POSITION_SEQ, POSITION, into);
}

// A float32 crosses the buffer as its bits. One shared DataView makes no
// object per call.
const convert = new DataView(new ArrayBuffer(4));

export function floatBits(value: number): number {
  convert.setFloat32(0, value);
  return convert.getInt32(0);
}

export function bitsFloat(bits: number): number {
  convert.setInt32(0, bits);
  return convert.getFloat32(0);
}
