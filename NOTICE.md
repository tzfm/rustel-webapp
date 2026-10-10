# Notices

This repository is AGPL-3.0-or-later (see `LICENSE`).

## Engine

The three wasm modules build on the rustel engine crates from
https://github.com/tzfm/rustel, licensed AGPL-3.0-or-later. The git
dependencies in `Cargo.toml` pin one revision. The `NOTICE.md` of the engine
repository lists the licences of the Rust dependencies the modules link.

## Development tools

The tools below build and check the page. The built files do not include them.

| Tool | Licence |
| --- | --- |
| TypeScript | Apache-2.0 |
| esbuild | MIT |
| Biome | MIT OR Apache-2.0 |
| @types/node | MIT |

## Runtime packages

The editor file of the page includes the packages below. A new runtime package
needs a row here.

| Package | Licence |
| --- | --- |
| @codemirror/commands | MIT |
| @codemirror/language | MIT |
| @codemirror/state | MIT |
| @codemirror/view | MIT |
| @lezer/common | MIT |
| @lezer/highlight | MIT |
| @lezer/lr | MIT |
| @marijn/find-cluster-break | MIT |
| crelt | MIT |
| style-mod | MIT |
| w3c-keyname | MIT |
