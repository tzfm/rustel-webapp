import assert from "node:assert/strict";
import { test } from "node:test";
import { effect, signal } from "../../src/app/signals.ts";

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

test("an effect runs at once and again after a change", async () => {
  const count = signal(1);
  const seen: number[] = [];
  effect(() => seen.push(count.get()));
  assert.deepEqual(seen, [1]);
  count.set(2);
  await settle();
  assert.deepEqual(seen, [1, 2]);
});

test("the same value causes no run, and several changes cause one", async () => {
  const count = signal(1);
  const seen: number[] = [];
  effect(() => seen.push(count.get()));
  count.set(1);
  count.set(2);
  count.set(3);
  await settle();
  assert.deepEqual(seen, [1, 3]);
});

test("an effect follows the signals of its last run", async () => {
  const useA = signal(true);
  const a = signal("a");
  const b = signal("b");
  const seen: string[] = [];
  effect(() => seen.push(useA.get() ? a.get() : b.get()));
  useA.set(false);
  await settle();
  a.set("a2");
  await settle();
  b.set("b2");
  await settle();
  assert.deepEqual(seen, ["a", "b", "b2"]);
});

test("a stopped effect does not run", async () => {
  const count = signal(1);
  const seen: number[] = [];
  const stop = effect(() => seen.push(count.get()));
  stop();
  count.set(2);
  await settle();
  assert.deepEqual(seen, [1]);
});
