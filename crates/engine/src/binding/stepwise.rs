//! The stepwise names: `stepcat` and its spellings, `tour`, `zip`,
//! `polymeter` and `stepalt`. A pattern with a step count joins the others in
//! proportion to its steps.
//!
//! Source: `install/foundation/lists.rs`, `pattern/stepwise.rs`,
//! `pattern/polymeter.rs` and `pattern/stepalt.rs`. The engine charges the
//! work of a call against a pool and refuses a call past the pool. The binding
//! does not charge, so a call of absurd size runs to its end.

use crate::binding::install::{GLOBAL, METHOD};
use crate::binding::natives::{Call, Native, Phase, stepcat, stepcat_args};
use crate::binding::reify::reify_direct;
use crate::binding::tape::Arg;
use rustel_core::{
    Pattern, QueryLimit, mark_stepwise_refusal, query_limit_pattern, silence, stack,
};
use rustel_fraction::Fraction;

/// `tour(receiver, ...many)`: the receiver walks through the groups. Each
/// group comes once with the receiver before the group, among the members and
/// after the group. A list stays one group in the first part and spreads in
/// the last.
///
/// Source: `native_tour`.
fn tour_of(receiver: &Arg, many: &[Arg]) -> Result<Pattern, String> {
    let mut expanded: Vec<Arg> = Vec::new();
    for split in (1..=many.len()).rev() {
        expanded.extend(many[..split].iter().cloned());
        expanded.push(receiver.clone());
        expanded.extend(many[split..].iter().cloned());
    }
    for value in std::iter::once(receiver).chain(many) {
        match value {
            Arg::List(items) => expanded.extend(items.iter().cloned()),
            other => expanded.push(other.clone()),
        }
    }
    let pattern = stepcat_args(&expanded)?;
    // A singleton `stepcat` keeps the absence of a step count.
    Ok(match receiver {
        Arg::Pattern(source) if many.is_empty() && source.steps.is_none() => {
            pattern.with_steps(None)
        }
        _ => pattern,
    })
}

fn tour_method(call: &Call) -> Result<Pattern, String> {
    tour_of(&Arg::Pattern(call.receiver()?.clone()), call.args)
}

fn tour_global(call: &Call) -> Result<Pattern, String> {
    match call.args.split_first() {
        Some((receiver @ Arg::Pattern(_), many)) => tour_of(receiver, many),
        _ => Err("pat.tour is not a function".into()),
    }
}

/// The patterns of the arguments which have a step count. A value with no
/// step count is dropped, as the `hasSteps` filter of the engine does.
fn with_steps(args: &[Arg]) -> Vec<Pattern> {
    args.iter()
        .filter_map(|arg| match arg {
            Arg::Pattern(pattern) if pattern.steps.is_some() => Some(pattern.clone()),
            _ => None,
        })
        .collect()
}

/// `zip(a, b, c)`: the nth step of each, one after the other.
///
/// Source: `native_zip`.
fn zip(call: &Call) -> Result<Pattern, String> {
    let patterns = with_steps(call.args);
    if patterns
        .iter()
        .any(|pattern| pattern.steps.is_some_and(|steps| steps.numer() == 0))
    {
        return Err("Division by Zero".into());
    }
    Ok(rustel_core::zip(patterns))
}

/// The step refusal of this file, as a pattern which fails when queried.
fn refusal(operation: &'static str) -> Pattern {
    query_limit_pattern(mark_stepwise_refusal(QueryLimit::NativeFraction {
        operation,
    }))
}

/// A pattern sped up by a factor, with the checks of `polymeter`.
///
/// Source: `checked_polymeter_raw_fast`.
fn paced(pattern: Pattern, factor: Fraction) -> Pattern {
    let steps = pattern.steps;
    let refuse = || {
        mark_stepwise_refusal(QueryLimit::NativeFraction {
            operation: "polymeter",
        });
    };
    pattern
        .with_query_time(move |time| {
            time.checked_mul(factor).unwrap_or_else(|| {
                refuse();
                Fraction::ZERO
            })
        })
        .with_hap_time(move |time| {
            if factor == Fraction::ZERO {
                rustel_core::signal_query_error(|| "Division by Zero".into());
                return Fraction::ZERO;
            }
            time.checked_div(factor).unwrap_or_else(|| {
                refuse();
                Fraction::ZERO
            })
        })
        .with_steps(steps)
}

/// `polymeter(a, b)`: the patterns play at the same step rate. Their cycles
/// span the lcm of their step counts. A list as first argument takes the
/// older form, which the binding does not port.
///
/// Source: `native_polymeter_modern`.
fn polymeter(call: &Call) -> Result<Pattern, String> {
    if matches!(call.args.first(), Some(Arg::List(_))) {
        return Err("polymeter with a list is not supported by the binding".into());
    }
    let patterns = with_steps(call.args);
    let Some((last, rest)) = patterns.split_last() else {
        return Ok(silence());
    };
    // The lcm starts with the last pattern, as the engine does.
    let mut steps = last.steps.expect("a pattern with steps");
    for pattern in rest {
        let source = pattern.steps.expect("a pattern with steps");
        match steps.checked_lcm(source) {
            Some(next) => steps = next,
            None => return Ok(refusal("polymeter")),
        }
    }
    if steps == Fraction::ZERO {
        return Ok(rustel_core::combinators::nothing::<Pattern>());
    }
    let mut lanes = Vec::with_capacity(patterns.len());
    for pattern in patterns {
        let source = pattern.steps.expect("a pattern with steps");
        let Some(ratio) = steps.checked_div(source) else {
            return Ok(refusal("polymeter"));
        };
        lanes.push(paced(pattern, ratio).with_steps(None));
    }
    Ok(stack(lanes).with_steps(Some(steps)))
}

/// `stepalt(["a b", "c"], "d")`: each argument is a group. Cycle after cycle
/// takes the next member of each group, and the chosen patterns follow one
/// another in proportion to their steps. A group of nothing, or no pattern
/// with a positive step count, gives `nothing`.
///
/// Source: `native_stepalt`.
fn stepalt(call: &Call) -> Result<Pattern, String> {
    let mut groups: Vec<Vec<Pattern>> = Vec::with_capacity(call.args.len());
    for arg in call.args {
        groups.push(match arg {
            Arg::List(items) => items
                .iter()
                .map(reify_direct)
                .collect::<Result<Vec<_>, _>>()?,
            other => vec![reify_direct(other)?],
        });
    }
    // The lcm of the group lengths starts with the last, as the engine does.
    let mut cycles = groups
        .last()
        .map_or(Fraction::ZERO, |group| Fraction::int(group.len() as i128));
    for group in groups.iter().rev().skip(1) {
        match cycles.checked_lcm(Fraction::int(group.len() as i128)) {
            Some(next) => cycles = next,
            None => return Ok(refusal("stepalt")),
        }
    }
    let cycles =
        usize::try_from(cycles.numer().unsigned_abs()).map_err(|_| "stepalt is too large")?;
    let mut total = Fraction::ZERO;
    let mut items: Vec<Pattern> = Vec::new();
    for cycle in 0..cycles {
        for group in &groups {
            let pattern = &group[cycle % group.len()];
            if let Some(steps) = pattern.steps
                && steps > Fraction::ZERO
            {
                let Some(next) = total.checked_add(steps) else {
                    return Ok(refusal("stepalt"));
                };
                total = next;
                items.push(pattern.clone());
            }
        }
    }
    if items.is_empty() {
        return Ok(rustel_core::combinators::nothing::<Pattern>());
    }
    if items.len() == 1 {
        return Ok(items.remove(0).with_steps(Some(total)));
    }
    let mut begin = Fraction::ZERO;
    let mut compressed = Vec::with_capacity(items.len());
    for item in items {
        let steps = item.steps.expect("a retained item has steps");
        let planned = (|| {
            let end = begin.checked_add(steps)?;
            let from = begin.checked_div(total)?;
            let width = end.checked_div(total)?.checked_sub(from)?;
            Some((end, from, Fraction::ONE.checked_div(width)?))
        })();
        let Some((end, from, factor)) = planned else {
            return Ok(refusal("stepalt"));
        };
        compressed.push(item.with_steps(None).fast_gap(factor).late(from));
        begin = end;
    }
    Ok(stack(compressed).with_steps(Some(total)))
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
    native!("stepcat", GLOBAL, 0, Early, stepcat),
    native!("timecat", GLOBAL, 0, Early, stepcat),
    native!("tour", GLOBAL, 1, Early, tour_global),
    native!("zip", GLOBAL, 0, Early, zip),
    native!("stepalt", GLOBAL, 0, Early, stepalt),
    native!("polymeter", GLOBAL, 0, Early, polymeter),
    native!("pm", GLOBAL, 0, Early, polymeter),
    native!("tour", METHOD, 0, Early, tour_method),
    native!("timeCat", GLOBAL, 0, Late, stepcat),
    native!("s_cat", GLOBAL, 0, Late, stepcat),
    native!("s_polymeter", GLOBAL, 0, Late, polymeter),
    native!("s_alt", GLOBAL, 0, Late, stepalt),
    native!("s_tour", GLOBAL, 1, Late, tour_global),
    native!("s_tour", METHOD, 0, Late, tour_method),
    native!("s_zip", GLOBAL, 0, Late, zip),
];
