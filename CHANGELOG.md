# Changelog

## Unreleased

- First version. A page with a code editor plays scores of the pattern language in the browser.
- The engine of rustel runs as three wasm modules: the pattern engine with the score binding, the score transpiler and the audio renderer.
- A score runs in a Worker behind three walls: a frame on a second site, a content security policy on the Worker script, and a lockdown of the global names.
- A standby Worker takes over when a score hangs, makes the engine module trap or kills the Worker. The last good score plays on.
- The gate plays the 1,479 committed scores of the engine and compares each one with its golden row. 1,472 pass, and `web/tests/conformance/expected.json` names the other 7 with the reason.
- Each score starts with no stored callback error. The conformance run uses the transpiler glue of the page. The design notes name every table which grows while a score plays.
- The Rust tests check the pointer of an init call before they read through the pointer. A failed init is now a clear test failure.
