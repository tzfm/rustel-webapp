// The lockdown of the score Worker, applied to the global object of a Node
// thread. The conformance worker and a unit test share this file. The header of
// `worker.ts` says what the result proves.

import { readFileSync } from "node:fs";
import { ALLOWED_GLOBALS, lockdown } from "../../src/engine/score/lockdown.ts";

/** Lock this thread down as a Firefox Worker is locked down. */
export function lockNodeThread(): void {
  const browser = new Set<string | symbol>(
    JSON.parse(readFileSync(new URL("./firefox-worker-names.json", import.meta.url), "utf8")),
  );
  // The lockdown deletes each name which the allowlist lacks. A name only Node
  // has waits outside the global and comes back after the lockdown.
  const nodeOnly = new Map<string | symbol, PropertyDescriptor>();
  for (const key of Reflect.ownKeys(globalThis)) {
    // Reading the descriptor of a lazy name such as `fetch` loads its module.
    if (browser.has(key)) continue;
    const descriptor = Reflect.getOwnPropertyDescriptor(globalThis, key);
    if (descriptor) nodeOnly.set(key, descriptor);
  }
  for (const key of nodeOnly.keys()) Reflect.deleteProperty(globalThis, key);
  lockdown(globalThis, ALLOWED_GLOBALS);
  for (const [key, descriptor] of nodeOnly) Object.defineProperty(globalThis, key, descriptor);
}
