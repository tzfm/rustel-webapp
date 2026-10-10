//! The hand-written names. Each entry ports the rule of one name of the
//! engine runtime, and the comment names the engine function of the rule.
//! A name which only changes host state (tempo, samples, lanes) lives in the
//! host, since such a name holds no pattern rule.

use crate::binding::install::{GLOBAL, METHOD, PLAIN_CURRY};
use crate::binding::modulators::{modulate, modulator};
use crate::binding::reify::{
    pure_of, reify_bridged, reify_direct, reify_list_element, sequence_args,
};
use crate::binding::tape::Arg;
use rustel_core::value::FunctionRef;
use rustel_core::{OrderedMap, Pattern, Value, fastcat, pure, silence, slowcat, stack};
use rustel_fraction::Fraction;
use std::sync::LazyLock;

/// When a name installs, relative to the registry names. A later install
/// replaces an earlier one of the same name.
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Phase {
    Early,
    Late,
}

/// What a call hands to a native.
pub struct Call<'a> {
    /// The pattern a method is called on.
    pub this: Option<&'a Pattern>,
    pub args: &'a [Arg],
}

impl Call<'_> {
    /// An argument, undefined when the call holds fewer.
    pub fn arg(&self, index: usize) -> &Arg {
        self.args.get(index).unwrap_or(&Arg::Undefined)
    }

    /// The receiver of a method.
    pub fn receiver(&self) -> Result<&Pattern, String> {
        self.this
            .ok_or_else(|| "this method needs a pattern as its receiver".to_owned())
    }
}

#[derive(Clone, Copy)]
pub struct Native {
    pub name: &'static str,
    /// `GLOBAL`, `METHOD` or both.
    pub surface: u32,
    /// The `length` the host reports.
    pub length: u32,
    pub phase: Phase,
    pub run: fn(&Call) -> Result<Pattern, String>,
}

const BOTH: u32 = GLOBAL | METHOD;

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

/// The table. The host receives an index into the table. The groups of names
/// with their own file follow the names of this file.
pub static TABLE: LazyLock<Vec<Native>> = LazyLock::new(|| {
    [
        BASE,
        crate::binding::pick::PICKS,
        crate::binding::pick::OTHERS,
        crate::binding::stepwise::TABLE,
        crate::binding::generators::TABLE,
    ]
    .concat()
});

const BASE: &[Native] = &[
    native!("m", GLOBAL, 2, Early, mini_at),
    native!("pure", GLOBAL, 1, Early, |call| Ok(pure_of(call.arg(0)))),
    native!("stack", BOTH, 0, Early, |call| list(call, ListKind::Stack)),
    native!("polyrhythm", GLOBAL, 0, Early, |call| list(
        call,
        ListKind::Stack
    )),
    native!("pr", GLOBAL, 0, Early, |call| list(call, ListKind::Stack)),
    native!("cat", BOTH, 0, Early, |call| list(call, ListKind::Slow)),
    native!("slowcat", BOTH, 0, Early, |call| list(call, ListKind::Slow)),
    native!("fastcat", BOTH, 0, Early, |call| list(call, ListKind::Fast)),
    native!("sequence", BOTH, 0, Early, |call| list(
        call,
        ListKind::Fast
    )),
    native!("seq", BOTH, 0, Early, |call| list(call, ListKind::Fast)),
    native!("run", GLOBAL, 1, Early, run),
    native!("irand", GLOBAL, 1, Early, |call| Ok(
        rustel_core::signal::irand(&reify_bridged(call.arg(0))?)
    )),
    native!("randL", GLOBAL, 1, Early, |call| Ok(
        rustel_core::signal::rand_list(&reify_bridged(call.arg(0))?)
    )),
    native!("brandBy", GLOBAL, 1, Early, |call| Ok(
        rustel_core::signal::brand_by(&reify_bridged(call.arg(0))?)
    )),
    native!("innerJoin", METHOD, 0, Late, |call| Ok(call
        .receiver()?
        .inner_join())),
    native!("outerJoin", METHOD, 0, Late, |call| Ok(call
        .receiver()?
        .outer_join())),
    native!("join", METHOD, 0, Late, |call| Ok(call
        .receiver()?
        .mix_join())),
    native!("squeezeJoin", METHOD, 0, Late, |call| Ok(call
        .receiver()?
        .squeeze_join())),
    native!("resetJoin", METHOD, 0, Late, |call| Ok(call
        .receiver()?
        .reset_join())),
    native!("restartJoin", METHOD, 0, Late, |call| Ok(call
        .receiver()?
        .restart_join())),
    native!("withValue", METHOD, 1, Early, with_value),
    native!("fmap", METHOD, 1, Early, fmap),
    native!("superimpose", METHOD, 1, Late, |call| transformers(
        call,
        "superimpose",
        true
    )),
    native!("layer", METHOD, 1, Late, |call| transformers(
        call, "layer", false
    )),
    native!("bite", METHOD, 2, Late, bite),
    native!("arp", METHOD, 1, Late, arp),
    native!("hush", METHOD, 0, Late, |_| Ok(silence())),
    native!("collect", METHOD, 0, Late, |call| Ok(call
        .receiver()?
        .collect())),
    native!("splitQueries", METHOD, 0, Late, |call| Ok(call
        .receiver()?
        .split_queries())),
    native!("gap", GLOBAL, 1, Early, gap),
    native!("arrange", GLOBAL, 0, Late, arrange),
    native!("seqPLoop", GLOBAL, 0, Late, seq_p_loop),
    native!("xfade", METHOD, 2, Late, |call| xfade(
        call.receiver()?,
        call.arg(0),
        call.arg(1)
    )),
    native!("xfade", GLOBAL, 3, Late, |call| xfade_free(call)),
    native!("piano", METHOD, 0, Late, piano),
    native!("FX", METHOD, 0, Late, fx),
    native!("partials", BOTH, 1, Late, |call| list_control(
        call, "partials"
    )),
    native!("phases", BOTH, 1, Late, |call| list_control(call, "phases")),
    native!("sliderWithID", GLOBAL, 4, Early, |call| reify_direct(
        call.arg(1)
    )),
    native!("_scope", METHOD, 0, Late, visual),
    native!("_tscope", METHOD, 0, Late, visual),
    native!("_pianoroll", METHOD, 0, Late, visual),
    native!("_punchcard", METHOD, 0, Late, visual),
    native!("_wordfall", METHOD, 0, Late, visual),
    native!("_spiral", METHOD, 0, Late, visual),
    native!("_pitchwheel", METHOD, 0, Late, visual),
    native!("_spectrum", METHOD, 0, Late, visual),
    native!("scope", METHOD, 0, Late, visual),
    native!("tscope", METHOD, 0, Late, visual),
    native!("pianoroll", METHOD, 0, Late, visual),
    native!("punchcard", METHOD, 0, Late, visual),
    native!("wordfall", METHOD, 0, Late, visual),
    native!("spiral", METHOD, 0, Late, visual),
    native!("pitchwheel", METHOD, 0, Late, visual),
    native!("spectrum", METHOD, 0, Late, visual),
    native!("webaudio", METHOD, 0, Late, same),
    native!("csound", METHOD, 0, Late, same),
    native!("tone", METHOD, 0, Late, same),
    native!("webdirt", METHOD, 0, Late, same),
    native!("speak", METHOD, 0, Late, same),
    native!("wave", METHOD, 0, Late, same),
    native!("soundfont", METHOD, 0, Late, same),
    native!("dough", METHOD, 0, Late, same),
    native!("fscope", METHOD, 0, Late, same),
    native!("theme", METHOD, 0, Late, same),
    native!("fontFamily", METHOD, 0, Late, same),
    native!("fontSize", METHOD, 0, Late, same),
    native!("markcss", METHOD, 0, Late, same),
    native!("onTrigger", METHOD, 1, Late, same),
    native!("onTriggerTime", METHOD, 1, Late, same),
    native!("mini", GLOBAL, 0, Early, mini),
    native!("sortHapsByPart", METHOD, 0, Late, |call| Ok(call
        .receiver()?
        .sort_haps_by_part_pattern())),
    native!("reify", GLOBAL, 1, Early, |call| reify_direct(call.arg(0))),
    native!("filterHaps", METHOD, 1, Late, |call| filter_with(
        call, true
    )),
    native!("filterValues", METHOD, 1, Late, |call| filter_with(
        call, false
    )),
    native!("withQuerySpan", METHOD, 1, Late, with_query_span),
    native!("arpWith", METHOD, 1, Late, arp_with_method),
    native!("arpWith", GLOBAL | PLAIN_CURRY, 2, Late, arp_with_free),
    native!("log", METHOD, 0, Late, same),
    native!("logValues", METHOD, 0, Late, same),
    native!("soft", BOTH, 1, Late, |call| distort(call, "soft")),
    native!("hard", BOTH, 1, Late, |call| distort(call, "hard")),
    native!("cubic", BOTH, 1, Late, |call| distort(call, "cubic")),
    native!("diode", BOTH, 1, Late, |call| distort(call, "diode")),
    native!("asym", BOTH, 1, Late, |call| distort(call, "asym")),
    native!("fold", BOTH, 1, Late, |call| distort(call, "fold")),
    native!("sinefold", BOTH, 1, Late, |call| distort(call, "sinefold")),
    native!("chebyshev", BOTH, 1, Late, |call| distort(
        call,
        "chebyshev"
    )),
    native!("lfo", BOTH, 2, Late, |call| modulator(call, "lfo")),
    native!("env", BOTH, 2, Late, |call| modulator(call, "env")),
    native!("bmod", BOTH, 2, Late, |call| modulator(call, "bmod")),
    native!("modulate", METHOD, 3, Late, modulate),
];

/// `native_mini` (`surface/patterns.rs`): the transpiler-facing `m(text,
/// offset)`. A negative offset strips the source locations.
fn mini_at(call: &Call) -> Result<Pattern, String> {
    let Arg::Str(text) = call.arg(0) else {
        return Err("m() needs a string".into());
    };
    let offset = call.arg(1).as_number().unwrap_or(0.0) as i64;
    let pattern = rustel_mini::mini_at(text, usize::try_from(offset).unwrap_or(0))
        .map_err(|error| error.to_string())?;
    Ok(if offset < 0 {
        pattern.map_haps_native(|hap| Some(hap.clone().with_context(Vec::new())))
    } else {
        pattern
    })
}

#[derive(Clone, Copy)]
enum ListKind {
    Stack,
    Slow,
    Fast,
}

/// `lists::install` (`install/foundation/lists.rs`): `stack`, `cat`, `fastcat`
/// and their aliases, as globals and as methods. A method reads its receiver
/// as the first element. A list argument is a sub-sequence. One element is
/// returned unchanged, except for `stack`.
fn list(call: &Call, kind: ListKind) -> Result<Pattern, String> {
    let mut patterns = Vec::with_capacity(call.args.len() + 1);
    for value in call
        .this
        .map(|this| Arg::Pattern(this.clone()))
        .iter()
        .chain(call.args)
    {
        patterns.push(reify_list_element(value)?);
    }
    Ok(match kind {
        ListKind::Stack => stack(patterns),
        _ if patterns.len() == 1 => patterns.remove(0),
        ListKind::Slow => slowcat(patterns),
        ListKind::Fast if patterns.is_empty() => slowcat(patterns),
        ListKind::Fast => fastcat(patterns),
    })
}

/// `GeneratorOps::run` (`install/generators/patterns.rs`).
fn run(call: &Call) -> Result<Pattern, String> {
    run_pattern(reify_bridged(call.arg(0))?)
}

/// `run` of a count pattern: `0 1 2 ... n-1`.
pub fn run_pattern(count: Pattern) -> Result<Pattern, String> {
    use rustel_core::compose::{ComposeOp, compose, default_alignment};
    let zero = pure(Value::F64(0.0));
    let ranged = compose(
        &rustel_core::signal::saw(),
        &count,
        ComposeOp::Mul,
        default_alignment(),
    );
    let ranged = compose(&ranged, &zero, ComposeOp::Add, default_alignment());
    let combinators = crate::binding::reify::registry();
    let round = combinators.get("round").ok_or("run needs round")?;
    let segment = combinators.get("segment").ok_or("run needs segment")?;
    Ok(segment.call(&[count], round.call(&[], ranged)))
}

/// `install_value_methods` (`surface/setup.rs`). A value which is not a
/// function builds, and fails when queried.
fn with_value(call: &Call) -> Result<Pattern, String> {
    if call.args.is_empty() {
        return Err(".withValue() expects 1 inputs but got 0.".into());
    }
    let receiver = call.receiver()?;
    Ok(match call.arg(0) {
        Arg::Func(func) => receiver.fmap_js(func.id as usize),
        _ => rustel_core::query_error_pattern("func is not a function"),
    })
}

/// `fmap` (`surface/setup/pattern_surface.rs`) is `withValue`.
fn fmap(call: &Call) -> Result<Pattern, String> {
    if call.args.is_empty() {
        return Err(".fmap() expects 1 inputs but got 0.".into());
    }
    with_value(call)
}

/// `superimpose` and `layer` (`install/pattern_bindings.rs`): every argument
/// is a pattern transformer. A transformer applies right here.
fn transformers(call: &Call, name: &str, keep_original: bool) -> Result<Pattern, String> {
    if call.args.is_empty() {
        return Err(format!(".{name}() expects 1 inputs but got 0."));
    }
    let receiver = call.receiver()?;
    let mut functions: Vec<FunctionRef> = Vec::with_capacity(call.args.len());
    for arg in call.args {
        match reify_bridged(arg)?.as_pure() {
            Some(Value::Function(function)) => functions.push(function),
            _ => return Err(format!("{name}: expects pattern transformers")),
        }
    }
    Ok(if keep_original {
        rustel_core::combinators::superimpose(receiver, &functions)
    } else {
        rustel_core::combinators::layer(receiver, &functions)
    })
}

/// The `bite` closure of `install/pattern_bindings.rs`.
fn bite(call: &Call) -> Result<Pattern, String> {
    if call.args.is_empty() {
        return Err(".bite() expects 2 inputs but got 0.".into());
    }
    let receiver = call.receiver()?;
    let number = call
        .args
        .first()
        .map_or_else(|| Ok(silence()), reify_bridged)?;
    let index = call
        .args
        .get(1)
        .map_or_else(|| Ok(silence()), reify_bridged)?;
    Ok(rustel_core::combinators::bite(receiver, &number, &index))
}

/// `Number(x)` of the host: the coercion `coerced_number` applies.
fn js_number(arg: &Arg) -> f64 {
    match arg {
        Arg::Num(number) => *number,
        Arg::Bool(flag) => f64::from(u8::from(*flag)),
        Arg::Null => 0.0,
        Arg::Frac(fraction) => fraction.to_f64(),
        Arg::Str(text) => {
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

fn fraction_of(arg: &Arg, message: &str) -> Result<Fraction, String> {
    Fraction::from_f64(js_number(arg)).ok_or_else(|| message.to_owned())
}

/// `passthrough` (`install/compat/patterns.rs`): the pattern unchanged.
fn same(call: &Call) -> Result<Pattern, String> {
    Ok(call.receiver()?.clone())
}

/// `visual_pattern` (`install/repl/visuals.rs`): the pattern, with the slot
/// of its painter when the transpiler gave one as the second argument. No
/// painter is drawn.
fn visual(call: &Call) -> Result<Pattern, String> {
    let receiver = call.receiver()?;
    let slot = match call.arg(1) {
        Arg::Num(number) if number.fract() == 0.0 && (0.0..64.0).contains(number) => {
            Some(*number as u8)
        }
        _ => None,
    };
    Ok(slot.map_or_else(
        || receiver.clone(),
        |slot| receiver.with_ui_visual_slot(slot),
    ))
}

/// The `arp` closure of `install/pattern_bindings.rs`: one argument is the
/// index pattern, several are a sequence.
fn arp(call: &Call) -> Result<Pattern, String> {
    if call.args.is_empty() {
        return Err(".arp() expects 1 inputs but got 0.".into());
    }
    let indices = if call.args.len() == 1 {
        reify_bridged(call.arg(0))?
    } else {
        sequence_args(call.args)?
    };
    Ok(rustel_core::arp(call.receiver()?.clone(), indices))
}

/// `native_gap` (`surface/patterns.rs`): silence with a step count.
fn gap(call: &Call) -> Result<Pattern, String> {
    let steps = match call.arg(0) {
        Arg::Undefined => None,
        Arg::Num(number) => Fraction::from_f64(*number),
        _ => None,
    };
    Ok(silence().with_steps(steps))
}

/// `stepcat_items_bridged` (`pattern/stepwise.rs`): `stepcat` and `timeCat`.
/// An argument is a pattern, weighed by its own step count, or a list
/// `[weight, pattern]`. A missing weight takes the average of the known ones.
pub fn stepcat_args(args: &[Arg]) -> Result<Pattern, String> {
    let mut raw: Vec<(Option<Fraction>, &Arg)> = Vec::with_capacity(args.len());
    for arg in args {
        match arg {
            Arg::List(pair) => {
                let weight = pair.first().unwrap_or(&Arg::Undefined);
                let value = pair.get(1).unwrap_or(&Arg::Undefined);
                if args.len() == 1 && weight.is_undefined() {
                    let kind = if matches!(value, Arg::Null) {
                        "null"
                    } else {
                        "undefined"
                    };
                    return Err(format!(
                        "Cannot read properties of {kind} (reading '__steps_source')"
                    ));
                }
                raw.push((weight.as_number().and_then(Fraction::from_f64), value));
            }
            Arg::Undefined | Arg::Null => {
                let kind = if matches!(arg, Arg::Null) {
                    "null"
                } else {
                    "undefined"
                };
                return Err(format!(
                    "Cannot read properties of {kind} (reading '_steps')"
                ));
            }
            other => {
                let steps = match other {
                    Arg::Pattern(pattern) => pattern.steps,
                    _ => None,
                };
                raw.push((steps.or(Some(Fraction::ONE)), other));
            }
        }
    }
    let mut resolved: Vec<Option<Fraction>> = raw.iter().map(|(weight, _)| *weight).collect();
    let all_missing = resolved.iter().all(Option::is_none);
    if resolved.iter().any(Option::is_none) {
        let known: Vec<Fraction> = resolved.iter().flatten().copied().collect();
        if let Some(average) = rustel_core::combinators::stepcat_missing_weight(&known) {
            resolved
                .iter_mut()
                .filter(|weight| weight.is_none())
                .for_each(|weight| *weight = Some(average));
        }
    }
    let mut items = Vec::with_capacity(raw.len());
    for ((weight, value), resolved) in raw.into_iter().zip(resolved) {
        if all_missing {
            items.push((weight, reify_list_element(value)?));
        } else if args.len() > 1 && resolved == Some(Fraction::ZERO) {
            items.push((weight, silence()));
        } else {
            items.push((weight, reify_direct(value)?));
        }
    }
    Ok(rustel_core::combinators::stepcat(&items))
}

pub fn stepcat(call: &Call) -> Result<Pattern, String> {
    stepcat_args(call.args)
}

/// `arrange` (`install/native_surface/patterns.rs`): sections of `[cycles,
/// pattern]`, each played for its cycles.
fn arrange(call: &Call) -> Result<Pattern, String> {
    let mut items = Vec::with_capacity(call.args.len());
    let mut total = Fraction::ZERO;
    for section in call.args {
        let Arg::List(pair) = section else {
            return Err("an arrangement section must be an array".into());
        };
        let cycles = fraction_of(
            pair.first().unwrap_or(&Arg::Undefined),
            "arrangement cycles must be finite",
        )?;
        let pattern = reify_bridged(pair.get(1).unwrap_or(&Arg::Undefined))?;
        total = total
            .checked_add(cycles)
            .ok_or("arrangement total cycles overflow")?;
        items.push((Some(cycles), pattern.fast(cycles)));
    }
    Ok(rustel_core::combinators::stepcat(&items).slow(total))
}

/// `seq_p_loop` (`install/native_surface/composition.rs`): sections of
/// `[start, stop, pattern]` or `[stop, pattern]`, looped over the total.
fn seq_p_loop(call: &Call) -> Result<Pattern, String> {
    let mut previous = Fraction::ZERO;
    let mut sections = Vec::with_capacity(call.args.len());
    for arg in call.args {
        let Arg::List(section) = arg else {
            return Err("seqPLoop sections must be arrays".into());
        };
        let (start, stop, pattern) = if section.len() == 2 {
            (None, 0, 1)
        } else {
            (Some(0), 1, 2)
        };
        let start = match start {
            Some(index) => fraction_of(
                section.get(index).unwrap_or(&Arg::Undefined),
                "seqPLoop start must be finite",
            )?,
            None => previous,
        };
        let stop = fraction_of(
            section.get(stop).unwrap_or(&Arg::Undefined),
            "seqPLoop stop must be finite",
        )?;
        let pattern = reify_bridged(section.get(pattern).unwrap_or(&Arg::Undefined))?;
        sections.push((start, stop, pattern));
        previous = stop;
    }
    let total = previous;
    if total == Fraction::ZERO {
        return Ok(silence());
    }
    let mut patterns = Vec::with_capacity(sections.len());
    for (start, stop, pattern) in sections {
        let range = start.checked_div(total).zip(stop.checked_div(total));
        let (begin, end) =
            range.ok_or("seqPLoop section bounds exceed the native fraction range")?;
        patterns.push(rustel_core::pure_pattern(pattern).compress(begin, end));
    }
    Ok(stack(patterns).slow(total).inner_join())
}

/// `xfade_pattern` (`install/native_surface/composition.rs`).
fn xfade(a: &Pattern, position: &Arg, b: &Arg) -> Result<Pattern, String> {
    use rustel_core::compose::{ComposeOp, compose, default_alignment};
    let fade_gain = |value: &Value| {
        let value = rustel_core::util::parse_numeral(value).unwrap_or(f64::NAN);
        if value < 0.5 {
            1.0
        } else {
            1.0 - (value - 0.5) / 0.5
        }
    };
    let position = reify_bridged(position)?;
    let b = reify_bridged(b)?;
    let gain_a =
        position.fmap(move |value| Value::object([("gain".into(), Value::F64(fade_gain(value)))]));
    let gain_b = position.fmap(move |value| {
        let value = rustel_core::util::parse_numeral(value).unwrap_or(f64::NAN);
        Value::object([(
            "gain".into(),
            Value::F64(fade_gain(&Value::F64(1.0 - value))),
        )])
    });
    Ok(stack(vec![
        compose(a, &gain_a, ComposeOp::Mul, default_alignment()),
        compose(&b, &gain_b, ComposeOp::Mul, default_alignment()),
    ]))
}

fn xfade_free(call: &Call) -> Result<Pattern, String> {
    let a = reify_bridged(call.arg(0))?;
    xfade(&a, call.arg(1), call.arg(2))
}

/// `piano` (`install/native_surface/patterns.rs`): the piano sound, with a
/// pan which follows the pitch.
fn piano(call: &Call) -> Result<Pattern, String> {
    let max_pan = rustel_core::util::note_to_midi("C8", 3).unwrap_or(108.0);
    Ok(call.receiver()?.fmap(move |value| {
        let mut controls = match rustel_core::materialize_js_value(value) {
            Value::Object(controls) => controls,
            _ => OrderedMap::new(),
        };
        if controls.get("clip").is_none_or(Value::is_nullish) {
            controls.insert("clip".into(), Value::F64(1.0));
        }
        controls.insert("s".into(), Value::Str("piano".into()));
        controls.insert("release".into(), Value::F64(0.1));
        let midi = rustel_core::util::value_to_midi(&Value::Object(controls.clone()), Some(36.0))
            .unwrap_or(36.0);
        let pan = (midi.round() / max_pan).min(1.0) * 0.5 + 0.25;
        let previous = controls
            .get("pan")
            .filter(|value| value.js_truthy())
            .cloned()
            .unwrap_or(Value::F64(1.0));
        let pan = rustel_core::compose::ComposeOp::Mul.apply_scalar(&previous, &Value::F64(pan));
        controls.insert("pan".into(), pan);
        Value::Object(controls)
    }))
}

fn append_value(left: &Value, right: &Value) -> Value {
    let mut values = match rustel_core::materialize_js_value(left) {
        Value::List(values) => values,
        value => vec![value],
    };
    values.push(rustel_core::materialize_js_value(right));
    Value::List(values)
}

/// `reify_pattern_list` (`install/native_surface/controls.rs`): a list is a
/// pattern of one list, built by combining its elements.
fn pattern_list(arg: &Arg) -> Result<Pattern, String> {
    let Arg::List(items) = arg else {
        return reify_bridged(arg);
    };
    let mut result = pure(Value::List(Vec::new()));
    for item in items {
        result = result.app_both_with(reify_bridged(item)?, append_value);
    }
    Ok(result)
}

/// `fx` (`install/native_surface/controls.rs`): the arguments are effect
/// names, added to the list under `FX`.
fn fx(call: &Call) -> Result<Pattern, String> {
    let effects = pattern_list(&Arg::List(call.args.to_vec()))?;
    Ok(call.receiver()?.app_left_with(effects, |current, effects| {
        let mut controls = match rustel_core::materialize_js_value(current) {
            Value::Object(controls) => controls,
            _ => OrderedMap::new(),
        };
        let mut combined = match controls
            .get("FX")
            .cloned()
            .unwrap_or(Value::List(Vec::new()))
        {
            Value::List(values) => values,
            value => vec![value],
        };
        match rustel_core::materialize_js_value(effects) {
            Value::List(values) => combined.extend(values),
            value => combined.push(value),
        }
        controls.insert("FX".into(), Value::List(combined));
        Value::Object(controls)
    }))
}

/// `list_control_method` and `list_control_free`
/// (`install/native_surface/controls.rs`): `partials` and `phases` take a
/// list of patterns.
fn list_control(call: &Call, name: &'static str) -> Result<Pattern, String> {
    let values = pattern_list(call.arg(0))?;
    Ok(match call.this {
        Some(receiver) => receiver.app_left_with(values, move |current, value| {
            let mut controls = match rustel_core::materialize_js_value(current) {
                Value::Object(controls) => controls,
                _ => OrderedMap::new(),
            };
            controls.insert(name.into(), rustel_core::materialize_js_value(value));
            Value::Object(controls)
        }),
        None => values.fmap(move |value| {
            Value::object([(name.to_owned(), rustel_core::materialize_js_value(value))])
        }),
    })
}

/// `distort_pattern` (`install/native_surface/controls.rs`): `diode(0.3)` is
/// `distort("0.3:1:diode")`. A list argument keeps its amount and volume.
fn distort(call: &Call, algorithm: &'static str) -> Result<Pattern, String> {
    let arguments = reify_bridged(call.arg(0))?.fmap(move |value| {
        match rustel_core::materialize_js_value(value) {
            Value::List(mut values) => {
                values.push(Value::Str(algorithm.into()));
                Value::List(values)
            }
            value => Value::List(vec![value, Value::F64(1.0), Value::Str(algorithm.into())]),
        }
    });
    let receiver = call
        .this
        .cloned()
        .unwrap_or_else(|| pure(Value::object(std::iter::empty())));
    let spec = rustel_core::controls::default_control_registry()
        .get("distort")
        .ok_or("distort is not a control")?;
    Ok(spec.apply(&receiver, Some(arguments)))
}

/// The effects, in install order.
pub static EFFECTS: LazyLock<Vec<Effect>> =
    LazyLock::new(|| [BASE_EFFECTS, crate::binding::generators::EFFECTS].concat());

/// A name which answers a value and not a pattern.
#[derive(Clone, Copy)]
pub struct ValueNative {
    pub name: &'static str,
    pub length: u32,
    pub run: fn(&[Arg]) -> Result<Value, String>,
}

/// A name which sets a setting of the module and answers nothing.
#[derive(Clone, Copy)]
pub struct Effect {
    pub name: &'static str,
    pub length: u32,
    pub run: fn(&[Arg]) -> Result<(), String>,
}

const BASE_EFFECTS: &[Effect] = &[
    Effect {
        name: "setDefaultJoin",
        length: 1,
        run: set_default_join,
    },
    Effect {
        name: "useRNG",
        length: 0,
        run: use_rng,
    },
    Effect {
        name: "setMaxPolyphony",
        length: 1,
        run: set_max_polyphony,
    },
    Effect {
        name: "setDefaultVoicings",
        length: 1,
        run: set_default_voicings,
    },
];

/// `set_default` (`runtime/evaluation/voicing_surface.rs`): the name of the
/// voicing set which `voicing()` uses. A dictionary object needs the voicing
/// registry of the host and is not supported.
fn set_default_voicings(args: &[Arg]) -> Result<(), String> {
    match args.first() {
        Some(Arg::Str(name)) => {
            rustel_core::voicings::set_default_voicings(name);
            Ok(())
        }
        _ => Err("a voicing dictionary is not supported by the binding".into()),
    }
}

/// `set_default_join` (`install/native_surface/values.rs`): the alignment of
/// `add`, `set` and the controls. A name which is none is ignored.
fn set_default_join(args: &[Arg]) -> Result<(), String> {
    let name = match args.first() {
        Some(Arg::Str(text)) => text.to_lowercase(),
        _ => String::new(),
    };
    let name = if name == "squeezein" {
        "squeeze"
    } else {
        name.as_str()
    };
    if let Some(alignment) = rustel_core::compose::Alignment::from_name(name) {
        rustel_core::compose::set_default_alignment(alignment);
    }
    Ok(())
}

/// `use_rng` (`install/native_surface/values.rs`).
fn use_rng(args: &[Arg]) -> Result<(), String> {
    let mode = match args.first() {
        None | Some(Arg::Undefined) => "legacy",
        Some(Arg::Str(text)) => text,
        Some(_) => "other",
    };
    let mode = match mode {
        "legacy" => rustel_core::rng::RngMode::Legacy,
        "precise" => rustel_core::rng::RngMode::Precise,
        _ => {
            return Err(format!(
                "useRNG expects 'legacy' or 'precise', got '{mode}'"
            ));
        }
    };
    rustel_core::rng::use_rng(mode);
    Ok(())
}

/// `set_max_polyphony` (`install/native_surface/bindings.rs`).
fn set_max_polyphony(args: &[Arg]) -> Result<(), String> {
    let maximum = rustel_core::settings::MAX_CONFIGURABLE_POLYPHONY;
    match args.first().and_then(Arg::as_number) {
        Some(value)
            if value.is_finite()
                && value.fract() == 0.0
                && value >= 1.0
                && value <= maximum as f64 =>
        {
            rustel_core::settings::set_max_polyphony(value as usize);
            Ok(())
        }
        _ => Err(format!(
            "setMaxPolyphony requires a whole number from 1 to {maximum}"
        )),
    }
}

/// `native_mini_sequence` (`surface/patterns.rs`): `mini("a b")`, the
/// mini-notation parser as a function. One pattern is returned unchanged.
fn mini(call: &Call) -> Result<Pattern, String> {
    if let [Arg::Pattern(pattern)] = call.args {
        return Ok(pattern.clone());
    }
    let mut patterns = Vec::with_capacity(call.args.len());
    for arg in call.args {
        patterns.push(match arg {
            Arg::Pattern(pattern) => pattern.clone(),
            Arg::Str(text) => rustel_mini::mini(text).map_err(|error| error.to_string())?,
            Arg::Num(number) => {
                rustel_mini::mini(&Value::F64(*number).show()).map_err(|error| error.to_string())?
            }
            _ => return Err("mini() needs a string".into()),
        });
    }
    Ok(match patterns.len() {
        0 => silence(),
        1 => patterns.remove(0),
        _ => fastcat(patterns),
    })
}

/// `filterHaps(f)` keeps the haps for which `f(hap)` is true. `filterValues(f)`
/// reads `f(value)`. A value which is no function builds, and fails when
/// queried.
///
/// Source: `filter_callback` (`install/native_surface/callbacks.rs`).
fn filter_with(call: &Call, haps: bool) -> Result<Pattern, String> {
    if call.args.is_empty() {
        let name = if haps { ".filterHaps" } else { ".filterValues" };
        return Err(format!("{name}() expects 1 inputs but got 0."));
    }
    let receiver = call.receiver()?;
    let Arg::Func(function) = call.arg(0) else {
        return Ok(rustel_core::query_error_pattern(
            "filter predicate is not a function",
        ));
    };
    let id = function.id as usize;
    Ok(if haps {
        receiver.filter_haps_js(id)
    } else {
        receiver.filter_values_js(id)
    })
}

/// `withQuerySpan(f)`: the function changes the span of each query.
///
/// Source: `with_query_span` (`install/native_surface/callbacks.rs`).
fn with_query_span(call: &Call) -> Result<Pattern, String> {
    if call.args.is_empty() {
        return Err(".withQuerySpan() expects 1 inputs but got 0.".into());
    }
    let receiver = call.receiver()?;
    let Arg::Func(function) = call.arg(0) else {
        return Ok(rustel_core::query_error_pattern(
            "withQuerySpan callback is not a function",
        ));
    };
    Ok(receiver.with_query_span_js(function.id as usize))
}

/// `pat.arpWith(f)`: the function gets the haps of each chord. Several
/// arguments, or a pattern, are a pattern of functions.
///
/// Source: the `arpWith` closure of `install/pattern_bindings.rs`.
fn arp_with_method(call: &Call) -> Result<Pattern, String> {
    if call.args.is_empty() {
        return Err(".arpWith() expects 1 inputs but got 0.".into());
    }
    let receiver = call.receiver()?.clone();
    if let [Arg::Func(function)] = call.args {
        return Ok(rustel_core::arp_with(receiver, function.id as usize));
    }
    let mut callbacks = call
        .args
        .iter()
        .map(reify_bridged)
        .collect::<Result<Vec<_>, _>>()?;
    let callbacks = match callbacks.len() {
        1 => callbacks.remove(0),
        _ => fastcat(callbacks),
    };
    Ok(rustel_core::arp_with_pattern(receiver, callbacks))
}

/// `arpWith(f, pattern)`, curried, the pattern last.
fn arp_with_free(call: &Call) -> Result<Pattern, String> {
    let receiver = match call.args.get(1) {
        Some(value) => reify_bridged(value)?,
        None => silence(),
    };
    Ok(match call.arg(0) {
        Arg::Func(function) => rustel_core::arp_with(receiver, function.id as usize),
        other => rustel_core::arp_with_pattern(receiver, reify_bridged(other)?),
    })
}
