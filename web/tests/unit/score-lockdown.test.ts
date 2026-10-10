// The lockdown on fresh objects which stand in for a global. The freeze reaches
// the language objects of the realm which runs the lockdown, and the test runner
// needs open language objects. So each test runs in a worker thread of its own:
// a fresh realm, which also lets a test check the objects open before the
// lockdown. The conformance run applies the lockdown to a real global and runs
// real scores. The last tests lock down the real global of their worker, as the
// conformance run does, for two paths of the glue which no golden score takes.

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { isMainThread, Worker, workerData } from "node:worker_threads";
import { ALLOWED_GLOBALS, lockdown, requireLockdown } from "../../src/engine/score/lockdown.ts";
import { lockNodeThread } from "../conformance/lock-node.ts";
import type { Pattern } from "./score-fixture.ts";

type Global = Record<string, unknown>;

/** The language names of this realm on a fresh object, and some names of a browser. */
function standIn(): Global {
  const global: Global = {};
  for (const name of ALLOWED_GLOBALS) {
    global[name] = name === "globalThis" ? global : (globalThis as Global)[name];
  }
  return Object.assign(global, { fetch() {}, postMessage() {}, setTimeout() {} });
}

/** The score fixture on a thread locked down like a Worker. The glue loads first, as in a Worker. */
async function afterLockdown() {
  const { open } = await import("./score-fixture.ts");
  lockNodeThread();
  return open();
}

const tests: Record<string, () => void | Promise<void>> = {
  "every allowed name exists": () => {
    for (const name of ALLOWED_GLOBALS) assert.ok(name in globalThis, name);
  },

  "a name off the list is gone from the global and from its prototypes": () => {
    const outer = Object.create(null, { inherited: { value: 1, configurable: true } });
    const inner = Object.create(outer, { alsoInherited: { value: 1, configurable: true } });
    const tag = Symbol("tag");
    const global = Object.assign(Object.create(inner), { kept: 1, dropped: 2, [tag]: 3 });
    lockdown(global, ["kept"]);
    assert.deepEqual(Reflect.ownKeys(global), ["kept"]);
    for (const name of ["dropped", "inherited", "alsoInherited", tag]) {
      assert.equal(Reflect.has(global, name), false, String(name));
    }
    assert.equal(global.kept, 1);
  },

  "a name which does not delete makes the function throw": () => {
    const global = Object.defineProperty({ kept: 1 }, "stuck", { value: 1 });
    assert.throws(() => lockdown(global, ["kept"]), /stuck does not delete/);
  },

  "a name which comes back or appears makes the function throw": () => {
    // A global which reports a delete and still holds the name.
    const back = new Proxy({ kept: 1, back: 1 }, { deleteProperty: () => true });
    assert.throws(() => lockdown(back, ["kept"]), /back came back/);
    // A global which makes a new name on each delete.
    const appears = new Proxy<Global>(
      { kept: 1, gone: 1 },
      {
        deleteProperty(target, key) {
          Reflect.deleteProperty(target, key);
          target.late = 1;
          return true;
        },
      },
    );
    assert.throws(() => lockdown(appears, ["kept"]), /late appeared/);
  },

  "a write to a name of a frozen prototype has no effect in sloppy code and throws in strict code":
    () => {
      const sloppy = new Function('const o = {}; o.toString = () => "mine"; return o.toString();');
      const strict = new Function('"use strict"; const o = {}; o.toString = () => "mine";');
      assert.equal(sloppy(), "mine");
      lockdown(standIn(), ALLOWED_GLOBALS);
      assert.equal(sloppy(), "[object Object]");
      assert.throws(() => strict(), TypeError);
    },

  "the replacement of the typed array length getter and of a global constructor fails": () => {
    const typedArray = Object.getPrototypeOf(Uint8Array) as { prototype: object };
    const length = Object.getOwnPropertyDescriptor(typedArray.prototype, "length");
    assert.ok(length);
    const replace = () => {
      Object.defineProperty(typedArray.prototype, "length", { ...length, get: () => 0 });
    };
    replace();
    assert.equal(new Uint8Array(4).length, 0);
    Object.defineProperty(typedArray.prototype, "length", length);

    const global = standIn();
    lockdown(global, ALLOWED_GLOBALS);
    assert.throws(replace, TypeError);
    assert.equal(new Uint8Array(4).length, 4);
    assert.throws(() => {
      global.Float64Array = new Proxy(Float64Array, {});
    }, TypeError);
    assert.equal(global.Float64Array, Float64Array);
    // The global stays open for new names.
    global.mine = 1;
    assert.equal(global.mine, 1);
  },

  "a second call changes nothing": () => {
    const global = standIn();
    lockdown(global, ALLOWED_GLOBALS);
    const names = Reflect.ownKeys(global);
    const descriptors = Object.getOwnPropertyDescriptors(global);
    lockdown(global, ALLOWED_GLOBALS);
    assert.deepEqual(Reflect.ownKeys(global), names);
    assert.deepEqual(Object.getOwnPropertyDescriptors(global), descriptors);
    assert.doesNotThrow(() => requireLockdown(global));
  },

  "score text is refused before the lockdown and after a failed one": () => {
    let works = false;
    const global = new Proxy<Global>(
      { kept: 1, dropped: 1 },
      { deleteProperty: (target, key) => works && Reflect.deleteProperty(target, key) },
    );
    assert.throws(() => requireLockdown(global), /did not end well/);
    assert.throws(() => lockdown(global, ["kept"]), /dropped does not delete/);
    assert.throws(() => requireLockdown(global), /did not end well/);
    // A later call which ends well does not repair the failure.
    works = true;
    lockdown(global, ["kept"]);
    assert.throws(() => requireLockdown(global), /did not end well/);

    const good = standIn();
    lockdown(good, ALLOWED_GLOBALS);
    assert.doesNotThrow(() => requireLockdown(good));
  },

  "a score function which throws is an error of the query after the lockdown": async () => {
    const { scope, query } = await afterLockdown();
    const failing = (scope.m("1 2", 0) as unknown as Pattern).fmap(() => {
      throw new Error("boom in the score");
    });
    const result = query(failing);
    assert.equal(result.count, 0);
    assert.match(result.thrown, /boom in the score/);
  },

  "a value with the key of a member of Object.prototype crosses the tape after the lockdown":
    async () => {
      const { binding } = await afterLockdown();
      for (const key of ["toString", "valueOf", "constructor", "hasOwnProperty", "__proto__"]) {
        const back = binding.echo({ [key]: 1 }) as object;
        assert.equal(Object.getOwnPropertyDescriptor(back, key)?.value, 1, key);
      }
    },
};

function inWorker(name: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL(import.meta.url), { workerData: name });
    worker.once("error", reject);
    worker.once("exit", (code) => (code === 0 ? resolve() : reject(new Error(`exit ${code}`))));
  });
}

if (isMainThread) {
  describe("the lockdown", () => {
    for (const name of Object.keys(tests)) test(name, () => inWorker(name));
  });
} else {
  await tests[workerData as string]();
}
