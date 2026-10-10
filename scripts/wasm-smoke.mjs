// Runs the two built modules together in Node, as the page runs them: the
// engine makes event records, the glue moves them, and the renderer plays them.
// A short run plays four notes. Then a dense score plays for 12 s at four rates,
// and the renderer must refuse and miss no event. The renderer holds the events
// which wait and the events which sound in one pool of 64, and the engine sends
// an event only while the pool has room.
//
//   node scripts/wasm-smoke.mjs <dsp.wasm> <engine.wasm>

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const RATE = 48000;
const QUANTUM = 128;
// The glue turns the engine every 10 ms.
const TURN_FRAMES = 480;
const TURNS = 200;
// Seconds of a dense score, and its rates in events a second.
const DENSE_SECONDS = 12;
const DENSE_RATES = [32, 64, 96, 128];
// Event records the glue stages for one render call, at most.
const INBOX_RECORDS = 64;
// Words of the wire control block. The last one is the stop flag.
const CONTROL_WORDS = 9;
const PUBLISHED_WORDS = 8;
// Telemetry word indexes of the renderer.
const ACCEPTED = 0;
const REFUSED = 2;
const LATE = 3;

// The layouts are repr(C) structs of u32 fields on wasm32.
const DSP_FIELDS = ["recordBytes", "inbox", "control", "output", "telemetry"];
const ENGINE_FIELDS = [
  "text",
  "textCapacity",
  "error",
  "errorLen",
  "records",
  "recordBytes",
  "recordCapacity",
  "control",
  "refused",
  "position",
];

// The engine imports `host_call` for a score function. The smoke plays
// mini-notation and needs no callback, so a call is a failure.
const IMPORTS = {
  binding: {
    host_call() {
      throw new Error("the smoke needs no score function");
    },
  },
};

// The memory grows during a call, so every view is made fresh.
const words = (module, at, count) => new Uint32Array(module.memory.buffer, at, count);
const bytes = (module, at, count) => new Uint8Array(module.memory.buffer, at, count);

function layoutOf(module, address, fields) {
  assert.notEqual(address, 0, "init returned null");
  const values = words(module, address, fields.length);
  return Object.fromEntries(fields.map((name, at) => [name, values[at]]));
}

const [dspPath, enginePath] = process.argv.slice(2);
assert.ok(dspPath && enginePath, "usage: wasm-smoke.mjs <dsp> <engine>");
const dspModule = new WebAssembly.Module(readFileSync(dspPath));
const engineModule = new WebAssembly.Module(readFileSync(enginePath));

/** Plays the pattern text at `cps` cycles a second for `turns` turns of 10 ms. */
function play(pattern, cps, turns) {
  const dsp = new WebAssembly.Instance(dspModule, {}).exports;
  const engine = new WebAssembly.Instance(engineModule, IMPORTS).exports;
  const dspLayout = layoutOf(dsp, dsp.dsp_init(RATE, 64), DSP_FIELDS);
  const engineLayout = layoutOf(engine, engine.engine_init(RATE), ENGINE_FIELDS);

  // Both modules build one event layout, or the page stops.
  assert.equal(dspLayout.recordBytes, engineLayout.recordBytes);
  const size = engineLayout.recordBytes;
  const canonical = bytes(engine, engine.engine_canonical_event(), size);
  bytes(dsp, dspLayout.inbox, size).set(canonical);
  assert.equal(dsp.dsp_canonical_matches(), 1, "the canonical events differ");

  const text = new TextEncoder().encode(pattern);
  bytes(engine, engineLayout.text, text.length).set(text);
  engine.engine_set_cps(cps, 0);
  const generation = engine.engine_set_pattern(text.length, 0, 0, 0);
  assert.ok(generation >= 0, `the pattern failed with ${generation}`);
  engine.engine_play(0);

  let peak = 0;
  let rendered = 0;
  let moved = 0;
  for (let turn = 0; turn < turns; turn += 1) {
    const count = engine.engine_turn(turn * TURN_FRAMES, INBOX_RECORDS);
    assert.ok(count <= INBOX_RECORDS);
    // Stage the records, the control words and the stop flag for one render call.
    const made = bytes(engine, engineLayout.records, count * size);
    bytes(dsp, dspLayout.inbox, count * size).set(made);
    const control = words(dsp, dspLayout.control, CONTROL_WORDS);
    control.set(words(engine, engineLayout.control, PUBLISHED_WORDS));
    control[PUBLISHED_WORDS] = 0;
    moved += count;
    let staged = count;
    while (rendered < (turn + 1) * TURN_FRAMES) {
      dsp.dsp_render(rendered, staged);
      staged = 0;
      const out = new Float32Array(dsp.memory.buffer, dspLayout.output, QUANTUM * 2);
      for (const sample of out) {
        peak = Math.max(peak, Math.abs(sample));
      }
      rendered += QUANTUM;
    }
  }
  return {
    moved,
    peak,
    telemetry: words(dsp, dspLayout.telemetry, 8),
    allocations: dsp.dsp_allocations(),
  };
}

const short = play("c3 e3 g3 c4", 0.5, TURNS);
assert.ok(short.moved > 0, "the engine made no records");
assert.ok(short.telemetry[ACCEPTED] > 0, "the renderer accepted no events");
assert.equal(short.telemetry[LATE], 0, "late events");
assert.ok(short.peak > 0, "silence");
assert.equal(short.allocations, 0, "the render path allocated");
console.log(
  `wasm smoke: ${short.moved} records, ${short.telemetry[ACCEPTED]} accepted, ` +
    `${short.telemetry[LATE]} late, peak ${short.peak.toFixed(3)}, 0 allocations`,
);

for (const rate of DENSE_RATES) {
  const dense = play(`c3*${rate}`, 1, (DENSE_SECONDS * RATE) / TURN_FRAMES);
  const { telemetry } = dense;
  assert.equal(telemetry[REFUSED], 0, `${rate} a second: the renderer refused events`);
  assert.equal(telemetry[LATE], 0, `${rate} a second: late events`);
  assert.equal(telemetry[ACCEPTED], dense.moved, `${rate} a second: events missed`);
  assert.equal(dense.allocations, 0, `${rate} a second: the render path allocated`);
}
console.log(
  `wasm smoke, dense: ${DENSE_RATES.join(", ")} events a second for ${DENSE_SECONDS} s, ` +
    "0 refused, 0 late",
);
