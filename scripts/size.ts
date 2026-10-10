// Measures the brotli size (quality 11) of each file in dist, adds the sizes
// by group, and compares each group with size-budget.json. Fails when a
// group is over its budget. The first load row adds all groups: the page
// fetches every file on the first visit, the transpiler module too.
//
//     node scripts/size.ts

import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { brotliCompressSync, constants } from "node:zlib";

const root = join(import.meta.dirname, "..");
const dist = join(root, "dist");

const GROUPS: Record<string, string[]> = {
  "app script": ["app/main.js"],
  editor: ["app/editor.js"],
  "engine scripts": ["engine/frame.js", "engine/worker.js", "engine/worklet.js"],
  "dsp.wasm": ["engine/dsp.wasm"],
  "engine.wasm": ["engine/engine.wasm"],
  "transpiler.wasm": ["engine/transpiler.wasm"],
};
const OTHER = "other";

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? files(join(dir, entry.name)) : [join(dir, entry.name)],
  );
}

function brotli(path: string): number {
  const data = readFileSync(path);
  const params = {
    [constants.BROTLI_PARAM_QUALITY]: 11,
    [constants.BROTLI_PARAM_SIZE_HINT]: data.length,
  };
  return brotliCompressSync(data, { params }).length;
}

function groupOf(name: string): string {
  return Object.keys(GROUPS).find((group) => GROUPS[group].includes(name)) ?? OTHER;
}

const budget: Record<string, number> = JSON.parse(
  readFileSync(join(root, "size-budget.json"), "utf8"),
);
const sizes: Record<string, number> = {};
for (const path of files(dist).sort()) {
  const name = relative(dist, path);
  const group = groupOf(name);
  sizes[group] = (sizes[group] ?? 0) + brotli(path);
}

let failed = false;
let firstLoad = 0;
let firstLoadBudget = 0;
console.log("group".padEnd(16), "brotli".padStart(10), "budget".padStart(10));
for (const group of [...Object.keys(GROUPS), OTHER]) {
  const size = sizes[group] ?? 0;
  const limit = budget[group];
  const over = limit === undefined || size > limit;
  failed ||= over;
  firstLoad += size;
  firstLoadBudget += limit ?? 0;
  const note = limit === undefined ? "no budget" : over ? "over budget" : "";
  console.log(group.padEnd(16), String(size).padStart(10), String(limit ?? "-").padStart(10), note);
}
console.log(
  "first load".padEnd(16),
  String(firstLoad).padStart(10),
  String(firstLoadBudget).padStart(10),
);
if (failed) {
  console.error("a group is over its size budget");
  process.exitCode = 1;
}
