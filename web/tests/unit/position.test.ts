// The position exports of the engine module, through the built module: a
// position read from one instance and adopted by a second instance gives the same
// events from the same frame. Two instances of the module stand for the two
// Workers. The tests need the built module: run `scripts/wasm-build engine` first.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import { P_COVERED, P_PLAYING, POSITION_WORDS, wordsValue } from "../../src/engine/bridge.ts";

const MODULE = new URL(
  "../../../target/wasm32-unknown-unknown/release/rustel_web_engine.wasm",
  import.meta.url,
);
const compiled = new WebAssembly.Module(readFileSync(MODULE));
const RATE = 48_000;
/** The Worker turns the engine every 10 ms. */
const TURN = 480;
const LEAD_FRAMES = 384;
const PLAY_LEAD_FRAMES = 896;
const NOTES = "c3 e3 g3 c4";

interface Exports {
  memory: WebAssembly.Memory;
  engine_init(sampleRate: number): number;
  engine_set_pattern(length: number, control: number, waveform: number, frame: number): number;
  engine_set_cps(cps: number, frame: number): void;
  engine_play(frame: number): void;
  engine_turn(frame: number, free: number): number;
  engine_position(): void;
  engine_adopt(frame: number): number;
  engine_canonical_event(): number;
}

/** One instance of the module, driven as the Worker drives the instance. */
function instance() {
  const imports = {
    binding: {
      host_call() {
        throw new Error("a pattern of mini-notation needs no score function");
      },
    },
  };
  const engine = new WebAssembly.Instance(compiled, imports).exports as unknown as Exports;
  const address = engine.engine_init(RATE);
  const fields = new Uint32Array(engine.memory.buffer, address, 10);
  const layout = {
    text: fields[0],
    error: fields[2],
    errorLength: address + 3 * 4,
    records: fields[4],
    recordBytes: fields[5],
    control: fields[7],
    position: fields[9],
  };
  const view = (at: number, length: number) => new Uint32Array(engine.memory.buffer, at, length);
  return {
    layout,
    engine,
    pattern(text: string, frame = 0) {
      const bytes = new TextEncoder().encode(text);
      new Uint8Array(engine.memory.buffer, layout.text, bytes.length).set(bytes);
      assert.ok(engine.engine_set_pattern(bytes.length, 0, 0, frame) >= 0);
    },
    /** One turn: the records, as copies. */
    turn(frame: number): Uint8Array[] {
      const count = engine.engine_turn(frame, 256);
      const size = layout.recordBytes;
      const bytes = new Uint8Array(engine.memory.buffer, layout.records, count * size);
      return Array.from({ length: count }, (_, at) => bytes.slice(at * size, (at + 1) * size));
    },
    /** The position words after `engine_position`. */
    position(): Int32Array {
      engine.engine_position();
      return new Int32Array(view(layout.position, POSITION_WORDS));
    },
    adopt(words: Int32Array, frame: number): number {
      view(layout.position, POSITION_WORDS).set(words);
      return engine.engine_adopt(frame);
    },
    /** Generation and takeover frame of the control words. */
    control(): { generation: number; takeover: number } {
      const words = view(layout.control, 8);
      return { generation: wordsValue(words, 0), takeover: wordsValue(words, 2) };
    },
    message(): string {
      const length = view(layout.errorLength, 1)[0];
      return new TextDecoder().decode(new Uint8Array(engine.memory.buffer, layout.error, length));
    },
  };
}

type Instance = ReturnType<typeof instance>;

/** Where the fields of an event record sit. The module lays out the record, so the
 * offsets come from its canonical event, whose values are known. Two records
 * of the same event differ in padding bytes, so the tests compare the fields. */
function fieldsOf(second: Instance) {
  const { engine, layout } = second;
  const canonical = new Uint8Array(
    engine.memory.buffer,
    engine.engine_canonical_event(),
    layout.recordBytes,
  );
  const offsetOf = (needle: Uint8Array) => {
    const found: number[] = [];
    for (let at = 0; at + needle.length <= canonical.length; at += 1) {
      if (needle.every((byte, index) => canonical[at + index] === byte)) found.push(at);
    }
    assert.equal(found.length, 1, `the offset of ${needle}`);
    return found[0];
  };
  const word = (value: bigint) => {
    const bytes = new Uint8Array(8);
    new DataView(bytes.buffer).setBigUint64(0, value, true);
    return offsetOf(bytes);
  };
  const single = (value: number) => {
    const bytes = new Uint8Array(4);
    new DataView(bytes.buffer).setFloat32(0, value, true);
    return offsetOf(bytes);
  };
  return {
    generation: word(9n),
    frame: word(123_456_789_012n),
    freq: single(261.625_55),
  };
}

const u64 = (record: Uint8Array, at: number) =>
  Number(new DataView(record.buffer, record.byteOffset).getBigUint64(at, true));
const f32 = (record: Uint8Array, at: number) =>
  new DataView(record.buffer, record.byteOffset).getFloat32(at, true);

describe("the position of the engine module", () => {
  test("is stopped before the first play, and holds the mapping once the engine plays", () => {
    const first = instance();
    const before = first.position();
    assert.equal(before[P_PLAYING], 0);
    assert.equal(wordsValue(before, P_COVERED), 0);

    first.engine.engine_set_cps(1.5, 0);
    first.pattern(NOTES);
    first.engine.engine_play(9_600);
    // The reach grows by 0.5 s on each turn, so the fourth turn reaches 2 s.
    for (let turn = 0; turn < 4; turn += 1) first.turn(9_600 + turn * TURN);
    const words = first.position();
    assert.equal(words[P_PLAYING], 1);
    // The generation of the first play is 1, and the control words carry the same number.
    assert.equal(wordsValue(words, 0), 1);
    assert.equal(first.control().generation, 1);
    // The anchor is the first onset at cycle 0, the tempo is the one set.
    const floats = new Float64Array(words.buffer.slice(16, 40));
    assert.deepEqual([...floats], [(9_600 + PLAY_LEAD_FRAMES) / RATE, 0, 1.5]);
    // The queries reach 2 s past the last turn, less one refill step of 50 ms.
    const covered = wordsValue(words, P_COVERED);
    const last = 9_600 + 3 * TURN;
    // The events held at the last turn, and the frame of the last turn.
    assert.ok(words[11] > 0 && words[11] <= 60);
    assert.equal(words[12], last);
    assert.ok(covered >= last + 93_600 && covered <= last + 96_000, String(covered));
  });

  test("read from one instance and adopted by a second gives the same events from the same frame", () => {
    const HANG = 150;
    const PROMOTE = 250;
    const END = 700;
    const first = instance();
    first.engine.engine_set_cps(1.0, 0);
    first.pattern(NOTES);
    first.engine.engine_play(0);
    for (let turn = 0; turn < HANG; turn += 1) {
      // A tempo change and an update before the hang move the anchor.
      if (turn === 60) first.engine.engine_set_cps(1.5, turn * TURN);
      if (turn === 100) first.pattern("d3 f3 a3", turn * TURN);
      first.turn(turn * TURN);
    }
    const words = first.position();
    const covered = wordsValue(words, P_COVERED);
    const generation = first.control().generation;
    assert.equal(wordsValue(words, 0), generation);

    // The first instance goes on, as if the instance did not hang.
    const expected: Uint8Array[] = [];
    for (let turn = HANG; turn < END; turn += 1) expected.push(...first.turn(turn * TURN));

    // The second instance holds the same score and takes the position.
    const second = instance();
    second.pattern("d3 f3 a3");
    assert.equal(second.adopt(words, PROMOTE * TURN), generation + 1);
    const got: Uint8Array[] = [];
    for (let turn = PROMOTE; turn < END; turn += 1) got.push(...second.turn(turn * TURN));

    // The second instance cuts over on the first frame the first instance did not cover.
    assert.deepEqual(second.control(), { generation: generation + 1, takeover: covered });
    const at = fieldsOf(second);
    const reach = (END - 1) * TURN + 48_000;
    const window = (records: Uint8Array[]) =>
      records
        .filter((record) => u64(record, at.frame) >= covered && u64(record, at.frame) < reach)
        .map((record) => [u64(record, at.frame), f32(record, at.freq)]);
    assert.ok(window(expected).length > 15);
    assert.deepEqual(window(got), window(expected));
    assert.ok(got.every((record) => u64(record, at.generation) === generation + 1));
    assert.ok(got.every((record) => u64(record, at.frame) >= covered));
  });

  test("adopted late, takes over LEAD_FRAMES after the frame of the call", () => {
    const first = instance();
    first.engine.engine_set_cps(1.0, 0);
    first.pattern(NOTES);
    first.engine.engine_play(0);
    first.turn(0);
    const words = first.position();
    // The position is 3 s old: the first frame the position did not cover is past.
    const late = 5 * RATE;
    const second = instance();
    second.pattern(NOTES);
    assert.equal(second.adopt(words, late), 2);
    second.turn(late);
    assert.equal(second.control().takeover, late + LEAD_FRAMES);
  });

  test("a position with no tempo is refused and changes nothing", () => {
    const second = instance();
    second.pattern(NOTES);
    assert.equal(second.adopt(new Int32Array(POSITION_WORDS), 0), -1);
    assert.match(second.message(), /position/);
    assert.equal(second.position()[P_PLAYING], 0);
    assert.equal(second.control().generation, 0);
  });
});
