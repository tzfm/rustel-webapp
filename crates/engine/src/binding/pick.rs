//! The pick family and the choose family. A pick chooses a pattern out of a
//! lookup (a list or an object of patterns) by the values of a selector
//! pattern, then joins the chosen patterns. The join and the index rule give
//! the spellings: `pick` clamps and joins inside, `pickmod` takes the
//! remainder, `pickOut` joins outside, `pickRestart` and `pickReset` realign,
//! `inhabit` squeezes.
//!
//! Source: `install/generators/pick.rs`, `native_pick`, `derive_pick`,
//! `derive_pick_f` and `native_pick_lookup` (`surface/patterns.rs`),
//! `install/native_surface/patterns.rs` for the choose family.

use crate::binding::install::{GLOBAL, METHOD, PLAIN_CURRY};
use crate::binding::natives::{Call, Native, Phase};
use crate::binding::reify::{reify_bridged, reify_list_element, sequence_args};
use crate::binding::tape::Arg;
use rustel_core::{
    JoinMode, Pattern, PickIndexMode, PickLookup, Value, apply_functions_strict, pick,
    pick_f_compat, pick_patternified,
};
use rustel_fraction::Fraction;

/// The lookup of a list or an object, each value reified. A string reads as an
/// object of its characters, a number or a function as an empty object, and
/// nothing is refused, as `Object.keys` refuses nothing.
///
/// Source: `native_pick_lookup` and `pick_lookup_shape`.
fn lookup_of(arg: &Arg) -> Result<PickLookup, String> {
    match arg {
        Arg::List(items) => array_lookup(items),
        Arg::Object(members) => {
            let entries = members
                .iter()
                .map(|(key, value)| Ok((key.clone(), reify_bridged(value)?)))
                .collect::<Result<Vec<_>, String>>()?;
            Ok(PickLookup::Object {
                enumerable_len: entries.len(),
                entries,
            })
        }
        Arg::Str(text) => {
            let entries = text
                .chars()
                .enumerate()
                .map(|(index, character)| {
                    (
                        index.to_string(),
                        rustel_core::pure(Value::Str(character.to_string())),
                    )
                })
                .collect::<Vec<_>>();
            Ok(PickLookup::Object {
                enumerable_len: entries.len(),
                entries,
            })
        }
        Arg::Null | Arg::Undefined => Err("Cannot convert undefined or null to object".into()),
        _ => Ok(PickLookup::Object {
            enumerable_len: 0,
            entries: Vec::new(),
        }),
    }
}

fn array_lookup(items: &[Arg]) -> Result<PickLookup, String> {
    let entries = items
        .iter()
        .enumerate()
        .map(|(index, value)| Ok((index, reify_bridged(value)?)))
        .collect::<Result<Vec<_>, String>>()?;
    Ok(PickLookup::Array {
        enumerable_len: items.len(),
        length: items.len(),
        entries,
    })
}

/// The lookup of `squeeze`: a list only, since the engine calls `xs.map`.
///
/// Source: `native_squeeze_lookup` and `squeeze_lookup_shape`.
fn squeeze_lookup_of(arg: &Arg) -> Result<PickLookup, String> {
    match arg {
        Arg::List(items) => array_lookup(items),
        Arg::Null => Err("Cannot read properties of null (reading 'map')".into()),
        Arg::Undefined => Err("Cannot read properties of undefined (reading 'map')".into()),
        _ => Err("xs.map is not a function".into()),
    }
}

/// The pick of a lookup argument. A pattern which holds a lookup, or a pure
/// value which reads as one, is used as a lookup. Nothing is a pattern of
/// lookups. Any other pattern is a pattern of lookups, picked per hap.
///
/// Source: `derive_pick`.
fn derive_pick(
    lookup: &Arg,
    selector: Pattern,
    index_mode: PickIndexMode,
    join_mode: JoinMode,
) -> Result<Pattern, String> {
    if let Arg::Pattern(pattern) = lookup {
        let held = pattern.as_pick_lookup().or_else(|| {
            pattern
                .as_pure()
                .and_then(|value| PickLookup::from_value(&value))
        });
        if let Some(held) = held {
            let picked = pick(selector, held, index_mode, join_mode);
            return Ok(match pattern.pure_loc() {
                Some(loc) => picked.with_added_context(vec![loc]),
                None => picked,
            });
        }
        return Ok(pick_patternified(
            selector,
            pattern.clone(),
            index_mode,
            join_mode,
        ));
    }
    if matches!(lookup, Arg::Null | Arg::Undefined) {
        let lookup = reify_bridged(lookup)?;
        return Ok(pick_patternified(selector, lookup, index_mode, join_mode));
    }
    Ok(pick(selector, lookup_of(lookup)?, index_mode, join_mode))
}

/// `pat.pickRestart(lookup)` and the other methods. Several arguments are a
/// sequence to pick from, and none is refused.
fn pick_method(
    call: &Call,
    name: &str,
    index_mode: PickIndexMode,
    join_mode: JoinMode,
) -> Result<Pattern, String> {
    let selector = call.receiver()?.clone();
    if call.args.len() != 1 {
        if call.args.is_empty() {
            return Err(format!(".{name}() expects 1 input but got 0."));
        }
        let lookup = sequence_args(call.args)?;
        return Ok(pick_patternified(selector, lookup, index_mode, join_mode));
    }
    derive_pick(call.arg(0), selector, index_mode, join_mode)
}

/// `pat._pickRestart(lookup)`: the lookup is read as given.
///
/// Source: `derive_pick_unpatternified`.
fn pick_raw(
    call: &Call,
    index_mode: PickIndexMode,
    join_mode: JoinMode,
) -> Result<Pattern, String> {
    let selector = call.receiver()?.clone();
    Ok(pick(
        selector,
        lookup_of(call.arg(0))?,
        index_mode,
        join_mode,
    ))
}

/// `pickRestart(lookup, selector)`.
///
/// Source: `native_pick`.
fn pick_free(
    call: &Call,
    index_mode: PickIndexMode,
    join_mode: JoinMode,
) -> Result<Pattern, String> {
    let selector = reify_bridged(call.arg(1))?;
    derive_pick(call.arg(0), selector, index_mode, join_mode)
}

/// The global `pick(lookup, selector)`. A list in the second place is the
/// lookup, so the order of the arguments is free.
fn pick_global(call: &Call) -> Result<Pattern, String> {
    let (lookup, selector) = match (call.arg(0), call.arg(1)) {
        (lookup, selector @ Arg::List(_)) => (selector, lookup),
        (lookup, selector) => (lookup, selector),
    };
    let selector = reify_bridged(selector)?;
    derive_pick(lookup, selector, PickIndexMode::Clamp, JoinMode::Inner)
}

/// `squeeze(selector, lookup)`: the selector chooses by remainder and the
/// chosen patterns squeeze into the selector events.
fn squeeze_global(call: &Call) -> Result<Pattern, String> {
    if call.args.is_empty() {
        return Err(".squeeze() expects 2 inputs but got 0.".into());
    }
    let selector = reify_bridged(call.arg(0))?;
    let lookup = squeeze_lookup_of(call.arg(1))?;
    Ok(pick(
        selector,
        lookup,
        PickIndexMode::Modulo,
        JoinMode::Squeeze,
    ))
}

/// `pat.pickF(pick, lookup)` and `pickmodF`: choose a function out of a
/// lookup and apply the function to the receiver. `pickF` swaps its
/// arguments for a hap which holds a list, as the engine does.
///
/// Source: `derive_pick_f`.
fn pick_f(
    receiver: Pattern,
    pick_value: &Arg,
    lookup_value: &Arg,
    index_mode: PickIndexMode,
    compat_swap: bool,
) -> Result<Pattern, String> {
    if compat_swap {
        let first = reify_bridged(pick_value)?;
        let second = reify_bridged(lookup_value)?;
        return Ok(pick_f_compat(receiver, first, second, index_mode));
    }
    let selector = reify_bridged(pick_value)?;
    let functions = match lookup_value {
        Arg::Pattern(pattern) => {
            let held = pattern.as_pick_lookup().or_else(|| {
                pattern
                    .as_pure()
                    .and_then(|value| PickLookup::from_value(&value))
            });
            match held {
                Some(held) => {
                    let picked = pick(selector, held, index_mode, JoinMode::Inner);
                    match pattern.pure_loc() {
                        Some(loc) => picked.with_added_context(vec![loc]),
                        None => picked,
                    }
                }
                None => pick_patternified(selector, pattern.clone(), index_mode, JoinMode::Inner),
            }
        }
        other => pick(selector, lookup_of(other)?, index_mode, JoinMode::Inner),
    };
    Ok(apply_functions_strict(receiver, functions))
}

fn pick_f_method(call: &Call, name: &str, index_mode: PickIndexMode) -> Result<Pattern, String> {
    if call.args.len() != 2 {
        return Err(format!(
            ".{name}() expects 2 inputs but got {}.",
            call.args.len()
        ));
    }
    let receiver = call.receiver()?.clone();
    pick_f(
        receiver,
        call.arg(0),
        call.arg(1),
        index_mode,
        name == "pickF",
    )
}

fn pick_f_raw(
    call: &Call,
    index_mode: PickIndexMode,
    compat_swap: bool,
) -> Result<Pattern, String> {
    pick_f(
        call.receiver()?.clone(),
        call.arg(0),
        call.arg(1),
        index_mode,
        compat_swap,
    )
}

fn pick_f_free(
    call: &Call,
    index_mode: PickIndexMode,
    compat_swap: bool,
) -> Result<Pattern, String> {
    let receiver = reify_bridged(call.arg(2))?;
    pick_f(receiver, call.arg(0), call.arg(1), index_mode, compat_swap)
}

/// `chooseWith(selector, choices)`: the selector, scaled to the number of
/// choices, picks one. Source: `choose_from`.
fn choose_from(selector: Pattern, values: &[Arg], mode: JoinMode) -> Result<Pattern, String> {
    let selector = rustel_core::combinators::range(&selector, 0.0, values.len() as f64)
        .fmap(|value| Value::F64(value.as_f64().unwrap_or(f64::NAN).floor()));
    Ok(pick(
        selector,
        array_lookup(values)?,
        PickIndexMode::Clamp,
        mode,
    ))
}

fn choose_with(call: &Call, mode: JoinMode) -> Result<Pattern, String> {
    let Arg::List(choices) = call.arg(1) else {
        return Err("choices must be an array".into());
    };
    choose_from(reify_bridged(call.arg(0))?, choices, mode)
}

/// `choose(a, b, c)` picks by `rand` and joins outside. `chooseCycles` picks
/// once a cycle and joins inside. `chooseIn` picks by `rand` and joins inside.
/// Source: `choose_random` and `choose_inner_random`.
fn choose_random(call: &Call, cycles: bool) -> Result<Pattern, String> {
    let (selector, mode) = if cycles {
        (
            rustel_core::combinators::segment(&rustel_core::signal::rand(), Fraction::ONE),
            JoinMode::Inner,
        )
    } else {
        (rustel_core::signal::rand(), JoinMode::Outer)
    };
    choose_from(selector, call.args, mode)
}

fn choose_in(call: &Call) -> Result<Pattern, String> {
    choose_from(rustel_core::signal::rand(), call.args, JoinMode::Inner)
}

/// `pat.choose(a, b)` and `pat.choose2(a, b)`: the receiver is the selector.
/// `choose2` reads the selector as a bipolar signal.
fn choose_method(call: &Call, bipolar: bool) -> Result<Pattern, String> {
    if call.args.is_empty() {
        let name = if bipolar { ".choose2" } else { ".choose" };
        return Err(format!("{name}() expects 1 inputs but got 0."));
    }
    let selector = call.receiver()?;
    let selector = if bipolar {
        rustel_core::combinators::from_bipolar(selector)
    } else {
        selector.clone()
    };
    choose_from(selector, call.args, JoinMode::Outer)
}

/// The element `index` of what a pair argument holds, as the engine reads
/// `pair[index]`.
fn pair_at(pair: &Arg, index: usize) -> Result<Arg, String> {
    match pair {
        Arg::Null | Arg::Undefined => {
            let kind = if matches!(pair, Arg::Null) {
                "null"
            } else {
                "undefined"
            };
            Err(format!(
                "Cannot read properties of {kind} (reading '{index}')"
            ))
        }
        Arg::List(items) => Ok(items.get(index).cloned().unwrap_or(Arg::Undefined)),
        Arg::Str(text) => Ok(text
            .chars()
            .nth(index)
            .map_or(Arg::Undefined, |character| Arg::Str(character.to_string()))),
        _ => Ok(Arg::Undefined),
    }
}

/// `wchoose([a, 1], [b, 3])`: the second element of a pair is a weight. The
/// values are read first, then the weights.
///
/// Source: `native_wchoose`.
fn wchoose(call: &Call, cycles: bool) -> Result<Pattern, String> {
    let mut values = Vec::with_capacity(call.args.len());
    for pair in call.args {
        values.push(reify_bridged(&pair_at(pair, 0)?)?);
    }
    let mut weights = Vec::with_capacity(call.args.len());
    for pair in call.args {
        let weight = pair_at(pair, 1)?;
        if matches!(weight, Arg::Null | Arg::Undefined) {
            let kind = if matches!(weight, Arg::Null) {
                "null"
            } else {
                "undefined"
            };
            return Err(format!(
                "Cannot read properties of {kind} (reading '__steps_source')"
            ));
        }
        weights.push(reify_list_element(&weight)?);
    }
    Ok(rustel_core::wchoose(
        values.into_iter().zip(weights).collect(),
        cycles,
    ))
}

macro_rules! picks {
    ($($name:literal $index:ident $join:ident),* $(,)?) => {
        &[$(
            Native {
                name: $name,
                surface: METHOD,
                length: 1,
                phase: Phase::Early,
                run: |call| pick_method(call, $name, PickIndexMode::$index, JoinMode::$join),
            },
            Native {
                name: concat!("_", $name),
                surface: METHOD,
                length: 1,
                phase: Phase::Early,
                run: |call| pick_raw(call, PickIndexMode::$index, JoinMode::$join),
            },
            Native {
                name: $name,
                surface: GLOBAL | PLAIN_CURRY,
                length: 2,
                phase: Phase::Early,
                run: |call| pick_free(call, PickIndexMode::$index, JoinMode::$join),
            },
        )*]
    };
}

pub const PICKS: &[Native] = picks![
    "pick" Clamp Inner,
    "pickmod" Remainder Inner,
    "pickOut" Clamp Outer,
    "pickmodOut" Remainder Outer,
    "pickRestart" Clamp Restart,
    "pickmodRestart" Remainder Restart,
    "pickReset" Clamp Reset,
    "pickmodReset" Remainder Reset,
    "inhabit" Clamp Squeeze,
    "pickSqueeze" Clamp Squeeze,
    "inhabitmod" Remainder Squeeze,
    "pickmodSqueeze" Remainder Squeeze,
];

macro_rules! native {
    ($name:expr, $surface:expr, $length:literal, $phase:ident, $run:expr) => {
        Native {
            name: $name,
            surface: $surface,
            length: $length,
            phase: Phase::$phase,
            run: $run,
        }
    };
}

pub const OTHERS: &[Native] = &[
    native!("wchoose", GLOBAL, 0, Early, |call| wchoose(call, false)),
    native!("wchooseCycles", GLOBAL, 0, Early, |call| wchoose(
        call, true
    )),
    native!("wrandcat", GLOBAL, 0, Early, |call| wchoose(call, true)),
    native!("pick", GLOBAL, 2, Early, pick_global),
    native!("squeeze", GLOBAL, 2, Early, squeeze_global),
    native!("pickF", METHOD, 2, Early, |call| pick_f_method(
        call,
        "pickF",
        PickIndexMode::Clamp
    )),
    native!("pickmodF", METHOD, 2, Early, |call| pick_f_method(
        call,
        "pickmodF",
        PickIndexMode::Remainder
    )),
    native!("_pickF", METHOD, 2, Early, |call| pick_f_raw(
        call,
        PickIndexMode::Clamp,
        true
    )),
    native!("_pickmodF", METHOD, 2, Early, |call| pick_f_raw(
        call,
        PickIndexMode::Remainder,
        false
    )),
    native!("pickF", GLOBAL | PLAIN_CURRY, 3, Early, |call| pick_f_free(
        call,
        PickIndexMode::Clamp,
        true
    )),
    native!("pickmodF", GLOBAL | PLAIN_CURRY, 3, Early, |call| {
        pick_f_free(call, PickIndexMode::Remainder, false)
    }),
    native!("chooseWith", GLOBAL, 2, Late, |call| choose_with(
        call,
        JoinMode::Outer
    )),
    native!("chooseInWith", GLOBAL, 2, Late, |call| choose_with(
        call,
        JoinMode::Inner
    )),
    native!("choose", GLOBAL, 0, Late, |call| choose_random(call, false)),
    native!("chooseOut", GLOBAL, 0, Late, |call| choose_random(
        call, false
    )),
    native!("chooseIn", GLOBAL, 0, Late, choose_in),
    native!("chooseCycles", GLOBAL, 0, Late, |call| choose_random(
        call, true
    )),
    native!("randcat", GLOBAL, 0, Late, |call| choose_random(call, true)),
    native!("choose", METHOD, 0, Late, |call| choose_method(call, false)),
    native!("choose2", METHOD, 0, Late, |call| choose_method(call, true)),
];
