//! Generators and small tools: the binary patterns, `morph`, `into`,
//! `timeline`, and the dictionaries handed to the engine.
//!
//! Source: `install/generators/patterns.rs`, `install/native_surface`,
//! `install/compat/patterns.rs`, `install/repl/timeline.rs`.

use crate::binding::install::{GLOBAL, METHOD};
use crate::binding::json::stringify;
use crate::binding::natives::{Call, Effect, Native, Phase, ValueNative, run_pattern};
use crate::binding::reify::{registry, reify_bridged, reify_list_element};
use crate::binding::tape::Arg;
use rustel_core::compose::{ComposeOp, compose, default_alignment};
use rustel_core::value::FunctionRef;
use rustel_core::{Pattern, QueryLimit, Value, pure};
use rustel_fraction::Fraction;

thread_local! {
    /// The offsets of `timeline`. A new score starts them again.
    static TIMELINE: rustel_core::TimelineState = rustel_core::TimelineState::default();
}

/// Start a score: the timeline offsets and the default alignment go back to
/// their start. Source: `execute_score` (`runtime/evaluation.rs`).
pub fn begin_score() {
    TIMELINE.with(rustel_core::TimelineState::reset);
    rustel_core::compose::set_default_alignment(rustel_core::compose::Alignment::In);
}

fn combinator(name: &str) -> Result<&'static rustel_core::register::Registration, String> {
    registry()
        .get(name)
        .ok_or_else(|| format!("{name} is not registered"))
}

fn calc(left: &Pattern, op: ComposeOp, right: &Pattern) -> Pattern {
    compose(left, right, op, default_alignment())
}

/// The bits needed to write a number: `floor(log2(n)) + 1`.
fn bit_count(value: Pattern) -> Result<Pattern, String> {
    let logged = combinator("log2")?.call(&[], value);
    let floored = combinator("floor")?.call(&[], logged);
    Ok(calc(&floored, ComposeOp::Add, &pure(Value::F64(1.0))))
}

/// `binaryN(number, bits)`: the bits of a number as a pattern of 1 and 0,
/// most significant first.
///
/// Source: `GeneratorOps::binary_n`.
fn binary_n_pattern(number: Pattern, bits: Pattern) -> Result<Pattern, String> {
    let positions = calc(
        &run_pattern(bits.clone())?,
        ComposeOp::Mul,
        &pure(Value::F64(-1.0)),
    );
    let last = calc(&bits, ComposeOp::Sub, &pure(Value::F64(1.0)));
    let positions = calc(&positions, ComposeOp::Add, &last);
    let number = combinator("segment")?.call(&[bits], number);
    let shifted = calc(&number, ComposeOp::Brshift, &positions);
    Ok(calc(&shifted, ComposeOp::Band, &pure(Value::F64(1.0))))
}

fn js_to_int32(value: f64) -> i32 {
    if !value.is_finite() {
        return 0;
    }
    let value = value.trunc().rem_euclid(4_294_967_296.0);
    if value >= 2_147_483_648.0 {
        (value - 4_294_967_296.0) as i32
    } else {
        value as i32
    }
}

fn js_to_number(value: &Value) -> f64 {
    match value {
        Value::Null => 0.0,
        Value::Bool(flag) => f64::from(*flag),
        Value::F64(number) => *number,
        Value::Str(text) => {
            let text = text.trim();
            if text.is_empty() {
                0.0
            } else {
                text.parse().unwrap_or(f64::NAN)
            }
        }
        _ => f64::NAN,
    }
}

/// The bits of a number as a list value, for `binaryNL`.
///
/// Source: `binary_list_value`.
fn binary_list_value(number: &Value, bits: &Value) -> Value {
    let number = js_to_number(number);
    let start = js_to_number(bits) - 1.0;
    if start.is_nan() || start < 0.0 {
        return Value::List(Vec::new());
    }
    let count = if start >= u64::MAX as f64 {
        rustel_core::MAX_STEPWISE_ENTRIES + 1
    } else {
        start.floor() as u64 + 1
    };
    if rustel_core::charge_stepwise_entries("binaryNL", count).is_err() {
        return Value::Undefined;
    }
    let number = js_to_int32(number);
    Value::List(
        (0..count)
            .map(|index| {
                let shift = js_to_int32(start - index as f64) as u32 & 31;
                Value::F64(f64::from((number >> shift) & 1))
            })
            .collect(),
    )
}

fn binary_list(number: Pattern, bits: Pattern) -> Pattern {
    number.app_left_with(bits, binary_list_value)
}

/// A missing argument is the default.
fn argument_or(arg: &Arg, default: f64) -> Arg {
    if arg.is_undefined() {
        Arg::Num(default)
    } else {
        arg.clone()
    }
}

fn binary_n(call: &Call) -> Result<Pattern, String> {
    let bits = reify_bridged(&argument_or(call.arg(1), 16.0))?;
    binary_n_pattern(reify_bridged(call.arg(0))?, bits)
}

fn binary(call: &Call) -> Result<Pattern, String> {
    let bits = bit_count(reify_bridged(call.arg(0))?)?;
    binary_n_pattern(reify_bridged(call.arg(0))?, bits)
}

fn binary_nl(call: &Call) -> Result<Pattern, String> {
    let number = reify_bridged(call.arg(0))?;
    let bits = reify_bridged(&argument_or(call.arg(1), 16.0))?;
    Ok(binary_list(number, bits))
}

fn binary_l(call: &Call) -> Result<Pattern, String> {
    let bits = bit_count(reify_bridged(call.arg(0))?)?;
    Ok(binary_list(reify_bridged(call.arg(0))?, bits))
}

fn append(left: &Value, right: &Value) -> Value {
    let mut values = match rustel_core::materialize_js_value(left) {
        Value::List(values) => values,
        value => vec![value],
    };
    values.push(rustel_core::materialize_js_value(right));
    Value::List(values)
}

/// The pattern of a `morph` call, for one value `[from, to, by]`: the onsets
/// of the first rhythm move toward the onsets of the second by a fraction.
///
/// Source: `morph_value`.
fn morph_value(value: &Value) -> Pattern {
    let Value::List(parts) = rustel_core::materialize_js_value(value) else {
        return rustel_core::query_error_pattern("morph expects three values");
    };
    let Some(Value::List(from)) = parts.first().map(rustel_core::materialize_js_value) else {
        return rustel_core::query_error_pattern("morph expects an array source");
    };
    let Some(Value::List(to)) = parts.get(1).map(rustel_core::materialize_js_value) else {
        return rustel_core::query_error_pattern("morph expects an array target");
    };
    let Some(by) = parts
        .get(2)
        .and_then(rustel_core::register::value_to_fraction)
    else {
        return rustel_core::query_error_pattern("morph amount is invalid");
    };
    if from.is_empty() {
        return rustel_core::silence();
    }
    let onsets = |list: &[Value]| -> Vec<usize> {
        list.iter()
            .enumerate()
            .filter_map(|(index, value)| value.js_truthy().then_some(index))
            .collect()
    };
    let (from_at, to_at) = (onsets(&from), onsets(&to));
    if to_at.len() < from_at.len() || to.is_empty() {
        return rustel_core::query_error_pattern("morph masks have incompatible onsets");
    }
    let duration = Fraction::ONE.div(Fraction::from(from.len() as i64));
    let (from_len, to_len) = (
        Fraction::from(from.len() as i64),
        Fraction::from(to.len() as i64),
    );
    let patterns: Option<Vec<_>> = from_at
        .into_iter()
        .zip(to_at)
        .map(|(from, to)| {
            let from = Fraction::from(from as i64).div(from_len);
            let to = Fraction::from(to as i64).div(to_len);
            let begin = by.checked_mul(to.checked_sub(from)?)?.checked_add(from)?;
            let end = begin.checked_add(duration)?;
            Some(pure(Value::Bool(true)).compress(begin, end))
        })
        .collect();
    let Some(patterns) = patterns else {
        return rustel_core::query_limit_pattern(rustel_core::mark_stepwise_refusal(
            QueryLimit::NativeFraction { operation: "morph" },
        ));
    };
    rustel_core::stack(patterns).split_queries()
}

fn morph(call: &Call) -> Result<Pattern, String> {
    let from = reify_bridged(call.arg(0))?.fmap_collect();
    let combined = from
        .app_right_with(reify_bridged(call.arg(1))?, append)
        .app_right_with(reify_bridged(call.arg(2))?, append);
    Ok(combined
        .fmap_to_pure_pattern(|value| {
            rustel_core::purity::PurePattern::assert_pure(morph_value(value))
        })
        .inner_join())
}

/// `pat.into(pieces, fn)` and `pat.unjoin(pieces, fn)`: apply the function
/// to the receiver inside each piece. `into` flattens the result. A value
/// which is not a function builds, and fails when queried.
///
/// Source: `unjoin` (`install/compat/patterns.rs`).
fn unjoin(call: &Call, flatten: bool) -> Result<Pattern, String> {
    let receiver = call.receiver()?.clone();
    let pieces = reify_bridged(call.arg(0))?;
    let transform = match call.arg(1) {
        Arg::Undefined => None,
        Arg::Func(func) => Some(FunctionRef::js(func.id as usize)),
        _ => return Ok(rustel_core::query_error_pattern("func is not a function")),
    };
    let pattern = rustel_core::unjoin(receiver, pieces, transform.as_ref());
    Ok(if flatten {
        pattern.inner_join()
    } else {
        pattern
    })
}

/// `pat.timeline(times)`: play the pattern at the offsets of a pattern of
/// times, kept from one cycle to the next.
///
/// Source: `apply` (`install/repl/timeline.rs`).
fn timeline(call: &Call) -> Result<Pattern, String> {
    let pattern = call.receiver()?.clone();
    let times = if call.args.len() == 1 {
        reify_bridged(call.arg(0))?
    } else {
        rustel_core::fastcat(
            call.args
                .iter()
                .map(reify_list_element)
                .collect::<Result<Vec<_>, _>>()?,
        )
    };
    Ok(TIMELINE.with(|state| rustel_core::timeline(times, pattern, state.clone())))
}

macro_rules! native {
    ($name:literal, $surface:expr, $length:literal, $phase:ident, $run:expr) => {
        Native {
            name: $name,
            surface: $surface,
            length: $length,
            phase: Phase::$phase,
            run: $run,
        }
    };
}

pub const TABLE: &[Native] = &[
    native!("binaryN", GLOBAL, 1, Early, binary_n),
    native!("binary", GLOBAL, 1, Early, binary),
    native!("binaryNL", GLOBAL, 1, Early, binary_nl),
    native!("binaryL", GLOBAL, 1, Early, binary_l),
    native!("morph", GLOBAL, 3, Late, morph),
    native!("into", METHOD, 2, Late, |call| unjoin(call, true)),
    native!("unjoin", METHOD, 1, Late, |call| unjoin(call, false)),
    native!("timeline", METHOD, 0, Late, timeline),
];

/// The registered dictionary of a voicing set. A range defaults to F3 to A4.
///
/// Source: `register_native` and `add_voicings`
/// (`runtime/evaluation/voicing_surface.rs`).
fn register_voicings(args: &[Arg], add_signature: bool) -> Result<(), String> {
    let function = if add_signature {
        "addVoicings"
    } else {
        "registerVoicings"
    };
    let Some(Arg::Str(name)) = args.first() else {
        return Err(format!("{function}: the name must be a string"));
    };
    let json = args
        .get(1)
        .and_then(stringify)
        .ok_or("voicing dictionary is not JSON serializable")?;
    let range = if add_signature {
        match args.get(2) {
            Some(range) if !range.is_undefined() => Some(range.clone()),
            _ => Some(Arg::List(vec![
                Arg::Str("F3".into()),
                Arg::Str("A4".into()),
            ])),
        }
    } else {
        match args.get(2) {
            Some(Arg::Object(options)) => options
                .iter()
                .find_map(|(key, value)| (key == "range").then(|| value.clone())),
            _ => None,
        }
    };
    let range_json = match &range {
        None | Some(Arg::Undefined) => None,
        Some(range) => Some(stringify(range).ok_or("voicing range is not JSON serializable")?),
    };
    rustel_core::voicings::register_user_dict_json_with_range(
        name,
        &json,
        range_json.as_deref(),
        add_signature,
    )
}

/// `midimaps({ name: { lpf: 74 } })`: a name which is not a literal map is
/// refused, since a download has no place in an evaluation.
///
/// Source: `NativeMidimaps` (`surface/setup/midimap.rs`).
fn midimaps(args: &[Arg]) -> Result<(), String> {
    let map = match args.first() {
        Some(Arg::Str(_)) => {
            return Err("midimaps('github:...') needs the network, which score evaluation does not have - inline the map object instead".into());
        }
        None | Some(Arg::Null | Arg::Undefined) => Arg::Object(Vec::new()),
        Some(other) => other.clone(),
    };
    let json = stringify(&map).ok_or("MIDI maps must be JSON values")?;
    rustel_core::midimap::register_midi_maps_json(&json)
}

/// `defaultmidimap({ lpf: 74 })`. Source: `NativeDefaultMidimap`.
fn default_midimap(args: &[Arg]) -> Result<(), String> {
    let json = args
        .first()
        .and_then(stringify)
        .ok_or("MIDI map must be a JSON value")?;
    rustel_core::midimap::register_midi_map_json("default", &json)
}

pub const EFFECTS: &[Effect] = &[
    Effect {
        name: "addVoicings",
        length: 2,
        run: |args| register_voicings(args, true),
    },
    Effect {
        name: "registerVoicings",
        length: 2,
        run: |args| register_voicings(args, false),
    },
    Effect {
        name: "midimaps",
        length: 1,
        run: midimaps,
    },
    Effect {
        name: "defaultmidimap",
        length: 1,
        run: default_midimap,
    },
];

/// `getFreq('c3')`: the frequency of a note name or of a midi number.
///
/// Source: `get_freq` (`install/native_surface/values.rs`).
fn get_freq(args: &[Arg]) -> Result<Value, String> {
    let midi = match args.first() {
        Some(Arg::Num(number)) => *number,
        Some(Arg::Str(note)) => rustel_core::util::note_to_midi(note, 3)?,
        _ => return Err("not a note".into()),
    };
    Ok(Value::F64(rustel_core::util::midi_to_freq(midi)))
}

pub const VALUES: &[ValueNative] = &[ValueNative {
    name: "getFreq",
    length: 1,
    run: get_freq,
}];
