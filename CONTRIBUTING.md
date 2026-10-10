# Contributing

Run `scripts/gate` before each commit. The gate runs every check of the
repository and stops at the first failure.

## Tests

- A simple Rust test goes inside its file, at the bottom, in
  `#[cfg(test)] mod tests`.
- A long Rust test goes in the `tests/` folder of its crate.
- A TypeScript unit test goes in `web/tests/unit/`, as `name.test.ts`. Node
  runs these files with no build step. The score tests load the engine module:
  run `scripts/wasm-build engine` first.
- `web/tests/conformance/expected.json` lists each committed score of the
  engine which does not pass, with its class and reason. A score leaves the
  list only with its fix, and enters only with a proven cause.
- The conformance run applies the lockdown of the score Worker
  (`web/src/engine/score/lockdown.ts`) before the first score of each worker.
  `--lockdown off` runs without the lockdown, for a comparison by hand.
- `scripts/browser-test.ts` plays the built page in headless Firefox. The
  sequence is `web/tests/browser/run.ts`. The profile sets the volume scale to
  0. Keep this setting. The test runs three sessions, each in its own Firefox: the
  product headers with real scores, a hostile score and the editor, a Worker script sent
  with no policy header, and the recovery of the Worker. The recovery session
  puts the hook of `web/tests/browser/worker-hook.js` in front of the Worker
  script, since no score traps the engine module.
- A test of the Worker logic goes in `web/tests/unit/` when Node runs the code.
  The browser test holds what needs a browser: the policy, the lockdown of a
  real global and the position of an exception.

## Code

- TypeScript is strict and uses erasable syntax only: no enums, no parameter
  properties, no namespaces. The only runtime dependencies are the packages of
  the editor (CodeMirror and what the packages need). A new runtime dependency
  needs a reason in its commit message and a row in `NOTICE.md`. Install the package with
  `npm install --save-exact --ignore-scripts`, at an exact version which is at
  least two weeks old.
- The app page allows no inline style: `style-src 'self'`. Write no style
  element, no `style` attribute and no `unsafe-inline`. A library which writes
  style rules at run time goes into a shadow root, as the editor does.
- Rust uses edition 2024 and stays clean under clippy.
- Make no object in the worklet per render call.
- The Worker glue (`worker.ts`, `evaluate.ts`, `transpiler.ts`, `bridge.ts` and
  the files of `score/`) takes each global name which the allowlist of
  `score/lockdown.ts` lacks when its file loads, and looks up no such name
  later. The lockdown deletes the name before a score runs. Do not add a name
  to the allowlist for the glue.

## Comments

- Write short sentences in the present tense.
- Explain intent, units and limits. Do not narrate syntax.
- Name the thing instead of using a pronoun. Skip filler words.
- Use no em dash, and no semicolon in prose.
