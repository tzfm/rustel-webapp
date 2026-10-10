//! The install list. The host loops over the list at start and defines one name per
//! row, so the names and their order come from the engine registries and not
//! from a list kept in the host.
//!
//! Order: the early natives, the extension combinators, the pattern-module
//! combinators, the controls, the controls-module combinators, the composer
//! matrix, the late natives, the reads. A later row replaces an earlier row of
//! the same name. This is the order of `install_semantic_bindings` and
//! `pattern_bindings::install` (`install.rs`, `install/pattern_bindings.rs`).
//! A pattern-module combinator comes before the controls, so a control such as
//! `density` shadows the alias of `fast`.

use crate::binding::extras::{self, Callable};
use crate::binding::natives::{self, Phase};
use crate::binding::reify::registry;
use rustel_core::compose::{Alignment, ComposeOp};
use rustel_core::controls::{ControlSpec, default_control_registry};
use rustel_core::register::DeclaredIn;
use rustel_core::{Pattern, silence};
use std::sync::LazyLock;

/// A row kind. The host switches on this number.
pub const COMBINATOR: u32 = 0;
pub const CONTROL: u32 = 1;
/// A composer operation. A getter on the pattern returns a callable with one
/// member for each alignment row.
pub const COMPOSER: u32 = 2;
pub const ALIGNMENT: u32 = 3;
/// A method which composes under a fixed alignment: `struct`, `mask`, `out`.
pub const SHORTCUT: u32 = 4;
/// A name which is a pattern value: a signal, `silence`.
pub const READ: u32 = 5;
pub const NATIVE: u32 = 6;
/// A global which calls the method of the same name on its last argument:
/// `add(1, pattern)`. The arity is the number of arguments.
pub const FALLBACK: u32 = 7;
/// A global which sets a setting and answers nothing.
pub const EFFECT: u32 = 8;
/// A global which answers a value and not a pattern.
pub const VALUE: u32 = 9;

/// Row flags.
pub const TAKES_FUNCTION: u32 = 1;
pub const METHOD: u32 = 2;
pub const GLOBAL: u32 = 4;
/// The name belongs to an extension of the engine. A score registers the name anew.
pub const EXTENSION: u32 = 16;
/// The free form is a curry with no tag, as the engine runtime installs
/// the compatibility registrations.
pub const PLAIN_CURRY: u32 = 8;

/// Every registered name, aliases included, with its registration. The
/// compatibility registrations of the engine runtime follow the registry.
pub static COMBINATORS: LazyLock<Vec<(String, Callable)>> = LazyLock::new(|| {
    let registry = registry();
    let mut all: Vec<_> = registry
        .names()
        .into_iter()
        .map(|name| {
            (
                name.to_owned(),
                Callable::Registered(Box::new(
                    registry
                        .get(name)
                        .expect("a name from the registry")
                        .clone(),
                )),
            )
        })
        .collect();
    for extra in extras::registrations() {
        all.extend(
            extra
                .names
                .iter()
                .map(|name| (name.clone(), extra.callable.clone())),
        );
    }
    all
});

/// How many entries of `COMBINATORS` come from the registry.
pub fn registry_len() -> usize {
    registry().names().len()
}

/// Every control name, aliases included, in the order of the registry.
pub static CONTROLS: LazyLock<Vec<(String, ControlSpec)>> = LazyLock::new(|| {
    let controls = default_control_registry();
    controls
        .names()
        .map(|name| {
            (
                name.to_owned(),
                controls
                    .get(name)
                    .expect("a name from the registry")
                    .clone(),
            )
        })
        .collect()
});

/// A method which composes under a fixed alignment.
pub struct Shortcut {
    pub name: &'static str,
    pub op: ComposeOp,
    pub alignment: Alignment,
}

/// The bare alignment names default their operation to `set`. The named
/// shortcuts come after, so `reset` and `restart` are the `keepif` forms.
/// Source: `pattern_bindings::install`.
pub static SHORTCUTS: LazyLock<Vec<Shortcut>> = LazyLock::new(|| {
    let bare = Alignment::ALL.iter().map(|alignment| Shortcut {
        name: alignment.name(),
        op: ComposeOp::Set,
        alignment: *alignment,
    });
    let named = [
        ("struct", ComposeOp::KeepIf, Alignment::Out),
        ("structAll", ComposeOp::Keep, Alignment::Out),
        ("mask", ComposeOp::KeepIf, Alignment::In),
        ("maskAll", ComposeOp::Keep, Alignment::In),
        ("reset", ComposeOp::KeepIf, Alignment::Reset),
        ("resetAll", ComposeOp::Keep, Alignment::Reset),
        ("restart", ComposeOp::KeepIf, Alignment::Restart),
        ("restartAll", ComposeOp::Keep, Alignment::Restart),
    ]
    .into_iter()
    .map(|(name, op, alignment)| Shortcut {
        name,
        op,
        alignment,
    });
    bare.chain(named).collect()
});

/// The pattern values: `nothing`, `silence` and the signals, in install order.
/// Source: `values::install` and `generators::patterns::install`.
pub static READS: LazyLock<Vec<(&'static str, Pattern)>> = LazyLock::new(|| {
    let mut reads = vec![
        ("nothing", rustel_core::combinators::nothing::<Pattern>()),
        ("silence", silence()),
    ];
    reads.extend(rustel_core::signal::signals(None));
    // `span_signal` (`install/native_surface/controls.rs`).
    for name in ["cyclesPer", "per", "perCycle", "perx"] {
        reads.push((name, span_signal(name)));
    }
    reads
});

/// The methods which also exist as globals when no global of the name is
/// there. Source: `install_method_fallback` calls (`install/compat/patterns.rs`).
const FALLBACKS: &[(&str, u32)] = &[
    ("mask", 2),
    ("struct", 2),
    ("superimpose", 2),
    ("bite", 3),
    ("set", 2),
    ("keep", 2),
    ("keepif", 2),
    ("withValue", 2),
    ("add", 2),
    ("sub", 2),
    ("mul", 2),
    ("div", 2),
];

/// Names which copy a combinator, global and method. The engine runtime
/// copies the final values, so an alias is the same function.
/// Source: the alias loops of `pattern_bindings::install`.
const ALIASES: &[(&str, &str)] = &[
    ("s_taper", "shrink"),
    ("s_add", "take"),
    ("s_sub", "drop"),
    ("s_expand", "expand"),
    ("s_extend", "extend"),
    ("s_contract", "contract"),
    ("steps", "pace"),
];

/// One row of the list.
pub struct Row {
    pub kind: u32,
    pub name: String,
    pub arity: u32,
    pub flags: u32,
    pub index: u32,
}

fn combinators(rows: &mut Vec<Row>, wanted: impl Fn(DeclaredIn) -> bool) {
    for (index, (name, callable)) in COMBINATORS.iter().enumerate() {
        // The compatibility registrations come later, from `extras`.
        let Callable::Registered(registration) = callable else {
            continue;
        };
        if index >= registry_len() || !wanted(registration.declared_in) {
            continue;
        }
        // MIDI output is a method only. Source: `install_combinator`.
        let surface = if matches!(name.as_str(), "midi" | "serial") {
            METHOD
        } else {
            METHOD | GLOBAL
        };
        let function = if callable.takes_function() {
            TAKES_FUNCTION
        } else {
            0
        };
        let extension = if registration.declared_in.is_extension() {
            EXTENSION
        } else {
            0
        };
        rows.push(Row {
            kind: COMBINATOR,
            name: name.clone(),
            arity: callable.arity() as u32,
            flags: surface | function | extension,
            index: index as u32,
        });
    }
}

fn natives(rows: &mut Vec<Row>, phase: Phase) {
    for (index, native) in natives::TABLE
        .iter()
        .enumerate()
        .filter(|(_, native)| native.phase == phase)
    {
        rows.push(Row {
            kind: NATIVE,
            name: native.name.to_owned(),
            arity: native.length,
            flags: native.surface,
            index: index as u32,
        });
    }
}

/// The ordered rows.
pub fn rows() -> Vec<Row> {
    let mut rows = Vec::new();
    natives(&mut rows, Phase::Early);
    combinators(&mut rows, DeclaredIn::is_extension);
    combinators(&mut rows, |declared| declared == DeclaredIn::PatternModule);
    for (index, (name, spec)) in CONTROLS.iter().enumerate() {
        // `cps` is a combinator method too. The combinator keeps the method,
        // and the control is the global. Source: the control loop.
        let surface = if name == "cps" {
            GLOBAL
        } else {
            METHOD | GLOBAL
        };
        rows.push(Row {
            kind: CONTROL,
            name: name.clone(),
            arity: spec.names.len() as u32,
            flags: surface,
            index: index as u32,
        });
    }
    combinators(&mut rows, |declared| declared == DeclaredIn::ControlsModule);
    for (alias, canonical) in ALIASES {
        let Some(index) = COMBINATORS.iter().position(|(name, _)| name == canonical) else {
            continue;
        };
        let callable = &COMBINATORS[index].1;
        rows.push(Row {
            kind: COMBINATOR,
            name: (*alias).to_owned(),
            arity: callable.arity() as u32,
            flags: METHOD
                | GLOBAL
                | if callable.takes_function() {
                    TAKES_FUNCTION
                } else {
                    0
                },
            index: index as u32,
        });
    }
    for (alignment_index, alignment) in Alignment::ALL.iter().enumerate() {
        rows.push(Row {
            kind: ALIGNMENT,
            name: alignment.name().to_owned(),
            arity: 0,
            flags: 0,
            index: alignment_index as u32,
        });
    }
    for (index, op) in ComposeOp::ALL.iter().enumerate() {
        rows.push(Row {
            kind: COMPOSER,
            name: op.name().to_owned(),
            arity: 1,
            flags: METHOD,
            index: index as u32,
        });
    }
    for (index, shortcut) in SHORTCUTS.iter().enumerate() {
        rows.push(Row {
            kind: SHORTCUT,
            name: shortcut.name.to_owned(),
            arity: 1,
            flags: METHOD,
            index: index as u32,
        });
    }
    natives(&mut rows, Phase::Late);
    let mut offset = registry_len();
    for extra in extras::registrations() {
        let surface = if extra.global {
            METHOD | GLOBAL | PLAIN_CURRY
        } else {
            METHOD
        };
        let function = if extra.callable.takes_function() {
            TAKES_FUNCTION
        } else {
            0
        };
        for name in &extra.names {
            rows.push(Row {
                kind: COMBINATOR,
                name: name.clone(),
                arity: extra.callable.arity() as u32,
                flags: surface | function,
                index: offset as u32,
            });
            offset += 1;
        }
    }
    for (index, effect) in natives::EFFECTS.iter().enumerate() {
        rows.push(Row {
            kind: EFFECT,
            name: effect.name.to_owned(),
            arity: effect.length,
            flags: GLOBAL,
            index: index as u32,
        });
    }
    for (index, value) in crate::binding::generators::VALUES.iter().enumerate() {
        rows.push(Row {
            kind: VALUE,
            name: value.name.to_owned(),
            arity: value.length,
            flags: GLOBAL,
            index: index as u32,
        });
    }
    for (name, arity) in FALLBACKS {
        rows.push(Row {
            kind: FALLBACK,
            name: (*name).to_owned(),
            arity: *arity,
            flags: 0,
            index: 0,
        });
    }
    for (index, (name, _)) in READS.iter().enumerate() {
        rows.push(Row {
            kind: READ,
            name: (*name).to_owned(),
            arity: 0,
            flags: GLOBAL,
            index: index as u32,
        });
    }
    rows
}

fn span_signal(kind: &str) -> Pattern {
    use rustel_core::Value;
    match kind {
        "cyclesPer" => {
            rustel_core::state_signal(|state| Value::F64(state.span.duration().to_f64()))
        }
        "perx" => rustel_core::state_signal(|state| {
            Value::F64((1.0 / state.span.duration().to_f64()).log2() + 1.0)
        }),
        _ => rustel_core::state_signal(|state| Value::F64(1.0 / state.span.duration().to_f64())),
    }
}
