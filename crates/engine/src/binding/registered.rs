//! A name a score registers with `register`. The score gives a function body.
//! The name becomes a method of patterns and a curried function. The host
//! keeps the function and the surface. The calling rules are here: which
//! arguments become patterns, which stay values, when the body runs at once
//! and when the body runs for every combination of the values of its arguments.
//!
//! Source: `NativeRegisteredMethod`, `NativeRegistered`, `map_registered`
//! (`surface/setup/registration.rs`).

use crate::binding::host::{HOST, Item, call_body, keep_body};
use crate::binding::reify::{reify_direct, sequence_args};
use crate::binding::tape::Arg;
use rustel_core::{CallbackHost, Pattern, Value, pattern_of_js, silence};

/// The arguments are made into patterns, and a pattern argument is queried for
/// each of its values.
pub const PATTERNIFY: u32 = 1;
/// The result takes the step count of the receiver.
pub const PRESERVE_STEPS: u32 = 2;

/// What the host knows of a registered name.
pub struct Registered<'a> {
    pub name: &'a str,
    /// The id of the function of the score.
    pub function: u32,
    /// The `length` of the function.
    pub arity: i64,
    pub flags: u32,
    /// The id of the function which joins the mapped patterns, if any.
    pub join: Option<u32>,
}

/// Call a registered name. `receiver` is the pattern a method is called on.
/// A free call has no receiver and holds the pattern as its last argument.
pub fn call(
    registered: &Registered,
    receiver: Option<&Pattern>,
    args: &[Arg],
) -> Result<Pattern, String> {
    let patterns = match receiver {
        Some(receiver) => {
            let mut patterns = method_arguments(registered, args)?;
            patterns.push(receiver.clone());
            patterns
        }
        None => args
            .iter()
            .map(reify_direct)
            .collect::<Result<Vec<_>, _>>()?,
    };
    // The pattern is the last of the arguments.
    let Some(pattern) = patterns.last().cloned() else {
        return Err("a registered function needs a pattern".into());
    };
    let result = if registered.flags & PATTERNIFY != 0 {
        if registered.arity == 1 {
            body(registered.function, &[Item::Pattern(&pattern)])?
        } else {
            patternified(registered, &patterns, &pattern)?
        }
    } else {
        let items: Vec<Item> = patterns.iter().map(Item::Pattern).collect();
        body(registered.function, &items)?
    };
    Ok(if registered.flags & PRESERVE_STEPS != 0 {
        result.with_steps(pattern.steps)
    } else {
        result
    })
}

/// A method reads several arguments of a one-input name as a sequence, so
/// `.name(2, 4)` is `.name("2 4")`. No argument is refused, and any other
/// count must match the arity.
fn method_arguments(registered: &Registered, args: &[Arg]) -> Result<Vec<Pattern>, String> {
    let (name, arity) = (registered.name, registered.arity);
    if arity == 2 && args.len() != 1 {
        if args.is_empty() {
            return Err(format!(".{name}() expects {} inputs but got 0.", arity - 1));
        }
        return Ok(vec![sequence_args(args)?]);
    }
    if arity != args.len() as i64 + 1 {
        return Err(format!(
            ".{name}() expects {} inputs but got {}.",
            arity - 1,
            args.len()
        ));
    }
    args.iter().map(reify_direct).collect()
}

/// Run the function of the score. A pattern is the answer.
fn body(function: u32, items: &[Item]) -> Result<Pattern, String> {
    match call_body(function, items)? {
        Arg::Pattern(pattern) => Ok(pattern),
        _ => Err("registered result is not a Pattern".into()),
    }
}

/// The arguments before the pattern. When all hold one value, the function
/// runs now with the values, and the source locations of the values join the
/// result. Else the function runs for each combination of values, when the
/// pattern is queried, and the results are joined.
fn patternified(
    registered: &Registered,
    patterns: &[Pattern],
    pattern: &Pattern,
) -> Result<Pattern, String> {
    let leading = &patterns[..patterns.len() - 1];
    let mut values = Vec::with_capacity(leading.len());
    let mut locations = Vec::new();
    for leading in leading {
        match leading.as_pure() {
            // A value which is undefined or null counts as none.
            Some(value) if !matches!(value, Value::Undefined | Value::Null) => {
                values.push(value);
                locations.extend(leading.pure_loc());
            }
            _ => break,
        }
    }
    if values.len() == leading.len() {
        let mut items: Vec<Item> = values.iter().map(Item::Value).collect();
        items.push(Item::Pattern(pattern));
        return Ok(body(registered.function, &items)?.with_added_context(locations));
    }
    let mapped = match leading.split_first() {
        None => silence(),
        Some((first, rest)) => {
            let mut collected = first.fmap_collect();
            for next in rest {
                collected = collected.app_left_collect(next.clone());
            }
            pattern_of_js(collected, keep_body(registered.function, pattern.clone()))
        }
    };
    match registered.join {
        Some(join) => HOST.call_pattern(join as usize, mapped),
        None => Ok(mapped.inner_join()),
    }
}
