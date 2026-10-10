//! The binding: the Rust pattern engine behind one import, for a JavaScript
//! host.
//!
//! The host evaluates a score. The score builds patterns through names the
//! host defines from the install list. Each name encodes its arguments on a
//! tape and calls one export. The pattern graph lives here, behind u32
//! handles. A score function (a callback) runs in the host, behind the one
//! import `host_call`.
//!
//! | File | What |
//! |---|---|
//! | `tape.rs` | The value tape and the atom table. |
//! | `table.rs` | The pattern table and its handles. |
//! | `state.rs` | The state cells of the module. |
//! | `registered.rs` | The names a score registers. |
//! | `reify.rs` | Arguments into patterns, by the rules of the engine runtime. |
//! | `rules.rs` | The calling rules of combinators, controls and composers. |
//! | `install.rs` | The install list built from the engine registries. |
//! | `natives.rs` | The hand-written names. |
//! | `generators.rs`, `json.rs` | The binary patterns, `morph`, `into`, `timeline`, dictionaries. |
//! | `pick.rs` | The pick family and the choose family. |
//! | `stepwise.rs` | `stepcat`, `tour`, `zip`, `polymeter`, `stepalt`. |
//! | `extras.rs` | The compatibility registrations. |
//! | `modulators.rs` | `lfo`, `env`, `bmod`, `modulate`. |
//! | `host.rs` | The callback host and the import. |
//! | `exports.rs` | The `extern "C"` exports. |

pub mod exports;
pub mod extras;
pub mod generators;
pub mod host;
pub mod install;
pub mod json;
pub mod modulators;
pub mod natives;
pub mod pick;
pub mod registered;
pub mod reify;
pub mod rules;
pub mod state;
pub mod stepwise;
pub mod table;
pub mod tape;
