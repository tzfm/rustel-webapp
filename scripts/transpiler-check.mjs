// Runs the built transpiler module in Node over every committed score of the
// pinned engine, and compares each result with the native transpiler. Then
// checks the refusal path: sources which the engine refuses give the same
// diagnostics, and a source which overflows the stack ends in a trap.
//
//   node scripts/transpiler-check.mjs <transpiler.wasm>
//
// The scores are the files of crates/runtime/tests/e2e/scores in the checkout
// of the pinned engine, which cargo already holds. The native side is the
// example crates/transpiler/examples/native.rs. Both sides build the result
// text with the same code, so equal text means the two builds agree.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

const root = join(import.meta.dirname, "..");
const work = join(root, "target/transpiler-check");
const SCORES = "crates/runtime/tests/e2e/scores";
const NO_POSITION = 2n ** 64n - 1n;
const FIELDS = [
  "output",
  "body",
  "awaits",
  "mini_locations",
  "diagnostics",
  "widgets",
  "registrations",
];

// Sources which the engine refuses with a diagnostic. The first has a
// multi-byte character before the error, so the offset counts UTF-8 bytes. The
// last is parsed 512 levels deep, the most the engine admits, and uses 0.7 MB
// of the stack. The engine refuses the tree afterwards.
const REFUSALS = {
  "syntax-error": '// é😀\ns("bd"',
  "module-syntax": 's("bd")\nimport x from "y"',
  "too-deep": `${"(".repeat(600)}1${")".repeat(600)}`,
  "nesting-limit": `x = ${"{a:".repeat(512)}1${"}".repeat(512)}`,
};
// Passes the lexical scan of the engine, since each bracket closes at once,
// and recurses past the stack of 1 MiB.
const HOSTILE = `${"if(1)".repeat(30_000)}1`;
const SIMPLE = 's("bd")';

class Transpiler {
  constructor(module) {
    this.exports = new WebAssembly.Instance(module, {}).exports;
  }

  /** The result text, or null when the module returns the failure code. */
  run(bytes) {
    const { memory, tp_scratch, tp_transpile, tp_result } = this.exports;
    // The memory grows during a call, so every view is made fresh.
    const scratch = tp_scratch(bytes.length);
    new Uint8Array(memory.buffer, scratch, bytes.length).set(bytes);
    const length = tp_transpile(bytes.length);
    if (length === 0xffffffff) {
      return null;
    }
    const text = new Uint8Array(memory.buffer, tp_result(), length);
    return new TextDecoder("utf-8", { fatal: true }).decode(text);
  }

  /** The score position of a printed position as a key, or "none". */
  position(line, column) {
    const answer = BigInt.asUintN(64, this.exports.tp_original_position(line, column));
    return answer === NO_POSITION ? "none" : `${answer >> 32n},${answer & 0xffffffffn}`;
  }

  /** The runs of the line map over every printed position, as the native example writes them. */
  lineMapRuns(output) {
    const runs = [];
    output.split("\n").forEach((text, line) => {
      let previous;
      for (let column = 0; column <= Buffer.byteLength(text); column += 1) {
        const key = this.position(line, column);
        if (key !== previous) {
          const [sourceLine, sourceColumn] = key === "none" ? [-1, -1] : key.split(",").map(Number);
          runs.push([line, column, sourceLine, sourceColumn]);
          previous = key;
        }
      }
    });
    return runs;
  }
}

/** The scores sit in the checkout of the pinned engine, next to the crate rustel-transpiler. */
function scoresFolder() {
  const metadata = JSON.parse(
    execFileSync("cargo", ["metadata", "--format-version", "1"], {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 2 ** 28,
    }),
  );
  const engine = metadata.packages.find((entry) => entry.name === "rustel-transpiler");
  assert.ok(engine, "cargo metadata lists no rustel-transpiler");
  const folder = resolve(dirname(engine.manifest_path), "../runtime/tests/e2e/scores");
  assert.ok(existsSync(folder), `${SCORES} is missing in the pinned engine`);
  return folder;
}

/** Every .strudel file under the folder, as { name, bytes }. The name has no extension. */
function readSources(folder) {
  const walk = (dir) =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const path = join(dir, entry.name);
      return entry.isDirectory() ? walk(path) : entry.name.endsWith(".strudel") ? [path] : [];
    });
  return walk(folder).map((path) => ({
    name: relative(folder, path).slice(0, -".strudel".length).split(sep).join("/"),
    bytes: readFileSync(path),
  }));
}

/** Runs the native example over the folder. Returns the records by name. */
function nativeRecords(folder, label) {
  const file = join(work, `${label}.jsonl`);
  execFileSync(
    "cargo",
    ["run", "--quiet", "-p", "rustel-web-transpiler", "--example", "native", "--", folder, file],
    { cwd: root, stdio: "inherit" },
  );
  const records = new Map();
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (line === "") {
      continue;
    }
    // The result text is last on the line, up to the brace which closes the record.
    const raw = line.slice(line.indexOf('"result":') + '"result":'.length, -1);
    const record = JSON.parse(line);
    records.set(record.name, { raw, result: record.result, lineMap: record.line_map });
  }
  return records;
}

/** Names the fields in which the module differs from the native record. */
function differences(transpiler, source, native) {
  const raw = transpiler.run(source.bytes);
  if (raw === null) {
    return ["failure code"];
  }
  const result = JSON.parse(raw);
  const names = FIELDS.filter(
    (field) => JSON.stringify(result[field]) !== JSON.stringify(native.result[field]),
  );
  if (!Buffer.from(result.output).equals(Buffer.from(native.result.output))) {
    names.push("output bytes");
  }
  if (JSON.stringify(transpiler.lineMapRuns(result.output)) !== JSON.stringify(native.lineMap)) {
    names.push("line map");
  }
  if (raw !== native.raw) {
    names.push("whole text");
  }
  return names;
}

/** Compares every source with its native record. Returns the sources which differ. */
function compare(transpiler, sources, records) {
  assert.equal(records.size, sources.length, "the native run and the module see other sources");
  const different = [];
  for (const source of sources) {
    const native = records.get(source.name);
    assert.ok(native, `no native record for ${source.name}`);
    const fields = differences(transpiler, source, native);
    if (fields.length > 0) {
      different.push(`  ${source.name}: ${fields.join(", ")}`);
    }
  }
  return different;
}

function trapOf(call) {
  try {
    call();
  } catch (error) {
    return error;
  }
  return null;
}

const wasmPath = process.argv[2];
assert.ok(wasmPath, "usage: transpiler-check.mjs <transpiler.wasm>");
const module = new WebAssembly.Module(readFileSync(wasmPath));

const folder = scoresFolder();
const scores = readSources(folder);
assert.ok(scores.length > 0, `${SCORES} holds no score`);
rmSync(work, { recursive: true, force: true });
mkdirSync(join(work, "refusals"), { recursive: true });
for (const [name, text] of Object.entries(REFUSALS)) {
  writeFileSync(join(work, "refusals", `${name}.strudel`), text);
}

// Scores: one instance serves them all, as the Worker serves its scores.
const transpiler = new Transpiler(module);
const different = compare(transpiler, scores, nativeRecords(folder, "scores"));
if (different.length > 0) {
  assert.fail(
    `${different.length} of ${scores.length} results differ from native\n` +
      `${different.slice(0, 10).join("\n")}`,
  );
}

// Refusals: native refuses each source with a diagnostic, and the module gives the same result.
const refusals = readSources(join(work, "refusals"));
assert.equal(refusals.length, Object.keys(REFUSALS).length);
const refused = nativeRecords(join(work, "refusals"), "refusals");
for (const [name, record] of refused) {
  assert.ok(record.result.diagnostics.length > 0, `native does not refuse ${name}`);
  assert.equal(record.result.body, "", `native gives a refused source ${name} a body`);
}
assert.deepEqual(compare(new Transpiler(module), refusals, refused), []);

// Hostile source: a trap is a refusal. The host drops the instance and makes a new one.
const trap = trapOf(() => new Transpiler(module).run(Buffer.from(HOSTILE)));
assert.ok(
  trap instanceof WebAssembly.RuntimeError || trap instanceof RangeError,
  `the hostile source gave ${trap === null ? "a result" : trap}, not a trap`,
);
const fresh = JSON.parse(new Transpiler(module).run(Buffer.from(SIMPLE)));
assert.equal(fresh.diagnostics.length, 0, "a fresh instance refuses a simple score");
assert.ok(fresh.output.includes("bd"), "a fresh instance does not transpile a simple score");

console.log(
  `transpiler: ${scores.length} scores equal to native, ${refusals.length} refusals equal, ` +
    `hostile source trapped (${trap.name}), fresh instance transpiles`,
);
