import assert from "node:assert/strict";
import { test } from "node:test";
import { HANG_MS, look, PAUSE_MS, type Pulse, pulseAt } from "../../src/engine/watchdog.ts";

/** Looks every `step` ms from `from` to `to` at one turn count. Returns the time of the first hang, or undefined. */
function hangs(
  start: Pulse,
  turns: number,
  from: number,
  to: number,
  step = 20,
): { at?: number; pulse: Pulse } {
  let pulse = start;
  for (let now = from; now <= to; now += step) {
    const seen = look(pulse, turns, now, true);
    pulse = seen.pulse;
    if (seen.hung) return { at: now, pulse };
  }
  return { pulse };
}

test("a Worker which makes turns is never hung", () => {
  let pulse = pulseAt(10, 5000);
  for (let step = 1; step <= 500; step += 1) {
    const seen = look(pulse, 10 + step, 5000 + step * 20, true);
    assert.equal(seen.hung, false);
    pulse = seen.pulse;
  }
});

test("a busy Worker with no new turn is hung after the limit, seen by looks every 20 ms", () => {
  const found = hangs(pulseAt(10, 5000), 10, 5020, 9000);
  assert.equal(found.at, 5000 + HANG_MS);
  // One look short of the limit is no hang.
  assert.equal(hangs(pulseAt(10, 5000), 10, 5020, 5000 + HANG_MS - 20).at, undefined);
});

test("a new turn restarts the clock", () => {
  const first = hangs(pulseAt(10, 5000), 10, 5020, 5900);
  assert.equal(first.at, undefined);
  const seen = look(first.pulse, 11, 5920, true);
  assert.equal(seen.hung, false);
  assert.equal(hangs(seen.pulse, 11, 5940, 5920 + HANG_MS - 20).at, undefined);
  assert.equal(hangs(seen.pulse, 11, 5940, 7000).at, 5920 + HANG_MS);
});

test("an idle Worker is never hung, and the clock starts when the Worker gets busy", () => {
  const idle = look(pulseAt(10, 5000), 10, 60_000, false);
  assert.equal(idle.hung, false);
  assert.deepEqual(idle.pulse, pulseAt(10, 60_000));
  assert.equal(hangs(idle.pulse, 10, 60_020, 60_000 + HANG_MS - 20).at, undefined);
  assert.equal(hangs(idle.pulse, 10, 60_020, 62_000).at, 60_000 + HANG_MS);
});

test("the turn count wraps without a false hang", () => {
  const seen = look(pulseAt(0xffff_ffff, 100), 0, 120, true);
  assert.equal(seen.hung, false);
  assert.deepEqual(seen.pulse, pulseAt(0, 120));
});

// A background tab slows the timer of the frame page while the turns of the
// Worker go on. A look after a pause says nothing about the Worker by the time
// alone.

test("a look after a long pause with a higher count is healthy", () => {
  const seen = look(pulseAt(10, 5000), 6000, 65_000, true);
  assert.equal(seen.hung, false);
  assert.deepEqual(seen.pulse, pulseAt(6000, 65_000));
});

test("a look after a long pause with the same count does not fire on the look", () => {
  const pulse = pulseAt(10, 5000);
  for (const pause of [PAUSE_MS + 1, 1000, 1500, 60_000]) {
    const seen = look(pulse, 10, 5000 + pause, true);
    assert.equal(seen.hung, false, `${pause} ms`);
    assert.equal(seen.pulse.armed, true);
    assert.equal(seen.pulse.since, 5000 + pause);
  }
  // A pause of the usual size is no pause.
  assert.equal(look(pulse, 10, 5000 + PAUSE_MS, true).pulse.armed, false);
});

test("the look after the pause starts the clock, and the Worker is hung HANG_MS later", () => {
  const armed = look(pulseAt(10, 5000), 10, 65_000, true).pulse;
  // Looks every 20 ms.
  assert.equal(hangs(armed, 10, 65_020, 65_000 + HANG_MS - 20).at, undefined);
  assert.equal(hangs(armed, 10, 65_020, 67_000).at, 65_000 + HANG_MS);
});

test("a tab which looks once a second finds a hung Worker on the second look", () => {
  // The first look is a first look only. The second look, a second later, fires.
  const first = look(pulseAt(10, 0), 10, 1000, true);
  assert.equal(first.hung, false);
  const second = look(first.pulse, 10, 2000, true);
  assert.equal(second.hung, true);
  // A healthy Worker in the same tab is never hung.
  let pulse = pulseAt(10, 0);
  for (let count = 1; count <= 60; count += 1) {
    const seen = look(pulse, 10 + count * 100, count * 1000, true);
    assert.equal(seen.hung, false);
    pulse = seen.pulse;
  }
});

test("a pause with the same count and then a higher count is healthy", () => {
  const armed = look(pulseAt(10, 5000), 10, 9000, true).pulse;
  const seen = look(armed, 11, 9500, true);
  assert.equal(seen.hung, false);
  assert.deepEqual(seen.pulse, pulseAt(11, 9500));
});
