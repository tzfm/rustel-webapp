//! Turning what the host sent into patterns, by the rules of the engine
//! runtime. The source of each function is named in its comment.

use crate::binding::tape::{Arg, Func, to_value};
use rustel_core::register::{CombinatorFn, Registration, Registry};
use rustel_core::value::FunctionRef;
use rustel_core::{Pattern, Value, fastcat, pure, pure_pattern};
use std::sync::Arc;

/// The registered combinators, by name. Built once from the engine.
pub fn registry() -> &'static Registry {
    static REGISTRY: std::sync::LazyLock<Registry> =
        // The registry of the extension crate holds the core names and the
        // extension names.
        std::sync::LazyLock::new(rustel_ext::default_registry);
    &REGISTRY
}

/// Lists nest this deep at most (`MAX_LIST_DEPTH` of the engine runtime is
/// larger, and the binding needs no more than the tape allows).
const MAX_LIST_DEPTH: usize = 64;

/// `Value` of a host value, with a fresh identity for each pattern inside.
pub fn value_of(arg: &Arg) -> Value {
    // The identity only tells two pattern values apart. The counter is local
    // to the module, and a pattern value never crosses back by identity.
    thread_local! {
        static IDENTITY: std::cell::Cell<u64> = const { std::cell::Cell::new(0) };
    }
    IDENTITY.with(|identity| {
        let mut next = identity.get();
        let value = to_value(arg, &mut next);
        identity.set(next);
        value
    })
}

/// `native_pure` (`surface/patterns.rs`): `pure(x)`. A pattern becomes a
/// pattern of patterns, a function stays a value, nothing is parsed.
pub fn pure_of(arg: &Arg) -> Pattern {
    match arg {
        Arg::Pattern(inner) => pure_pattern(inner.clone()),
        Arg::Func(func) => pure(Value::Function(FunctionRef::js(func.id as usize))),
        other => pure(value_of(other)),
    }
}

/// `reify_value` (`surface/setup/registration.rs`), the lexical `reify`: a
/// pattern stays, any other value is `pure`. The engine sets no string parser
/// at start, so a single-quoted string stays a string. The transpiler turns
/// a double-quoted string into a call of `m`.
pub fn reify_direct(arg: &Arg) -> Result<Pattern, String> {
    Ok(match arg {
        Arg::Pattern(pattern) => pattern.clone(),
        other => pure_of(other),
    })
}

/// `reify_list_element_bridged` (`pattern/reify.rs`): a list is a
/// sub-sequence, so `stack("g3", ["e4", "d4"])` reads the list as `"e4 d4"`.
pub fn reify_list_element(arg: &Arg) -> Result<Pattern, String> {
    list_element(arg, 0)
}

fn list_element(arg: &Arg, depth: usize) -> Result<Pattern, String> {
    if depth == MAX_LIST_DEPTH {
        return Err("nested list depth exceeds the native limit".into());
    }
    match arg {
        Arg::List(items) => {
            let patterns = items
                .iter()
                .map(|item| list_element(item, depth + 1))
                .collect::<Result<Vec<_>, _>>()?;
            Ok(fastcat(patterns))
        }
        other => reify_direct(other),
    }
}

/// `sequence_args_bridged` (`surface/mod.rs`): several arguments are one
/// sequence, none is silence.
pub fn sequence_args(args: &[Arg]) -> Result<Pattern, String> {
    if args.is_empty() {
        return Ok(rustel_core::silence());
    }
    let mut patterns = args
        .iter()
        .map(reify_list_element)
        .collect::<Result<Vec<_>, _>>()?;
    Ok(if patterns.len() == 1 {
        patterns.remove(0)
    } else {
        fastcat(patterns)
    })
}

/// `reify_bridged` (`pattern/reify.rs`): the reification of an argument of a
/// registered name. A function becomes a pattern of one function, by its
/// combinator reference when the host tagged the function and the reference
/// holds, else by its callback.
pub fn reify_bridged(arg: &Arg) -> Result<Pattern, String> {
    match arg {
        Arg::Func(func) => Ok(pure(Value::Function(function_of(func)))),
        other => reify_direct(other),
    }
}

/// The reference of a tagged function, else the callback.
fn function_of(func: &Func) -> FunctionRef {
    reference(func, 0).unwrap_or_else(|| FunctionRef::js(func.id as usize))
}

/// `combinator_reference_within` (`pattern/reify.rs`): a tagged function whose
/// collected arguments are numbers, booleans or nested references becomes the
/// registered combinator with those arguments, with no callback. A bound
/// pattern, a bound string (the string parser stays replaceable until the
/// call completes) or a bound function which is not a reference keeps the function
/// on the callback path.
fn reference(func: &Func, depth: usize) -> Option<FunctionRef> {
    let (name, bound) = func.reference.as_ref()?;
    if depth >= 64 {
        return None;
    }
    let registration: Registration = registry().get(name)?.clone();
    // A tag which binds as many arguments as the arity is forged.
    if bound.len() >= registration.arity {
        return None;
    }
    let mut args = Vec::with_capacity(bound.len());
    for value in bound {
        args.push(match value {
            Arg::Pattern(_) | Arg::Str(_) => return None,
            Arg::Func(inner) => pure(Value::Function(reference(inner, depth + 1)?)),
            other => pure(value_of(other)),
        });
    }
    let provable_pure =
        matches!(registration.func, CombinatorFn::Native(_)) && args.iter().all(Pattern::is_pure);
    Some(FunctionRef::registered(
        name,
        Arc::new(move |pattern| registration.call(&args, pattern)),
        provable_pure,
    ))
}
