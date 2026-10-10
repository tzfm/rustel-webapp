//! The calling rules of the registry names, once, in Rust. The host encodes
//! the raw arguments and calls one export per kind. An `Err` is a message the
//! host throws as a `TypeError`.

use crate::binding::extras::Callable;
use crate::binding::reify::{reify_bridged, sequence_args};
use crate::binding::tape::Arg;
use rustel_core::compose::{self, Alignment, ComposeOp};
use rustel_core::controls::ControlSpec;
use rustel_core::{Pattern, pure, silence};

fn expects(name: &str, inputs: usize, got: usize) -> String {
    format!(".{name}() expects {inputs} inputs but got {got}.")
}

/// A registered combinator called as a method of `receiver`.
///
/// Source: the method closure of `install_combinator` (`surface/mod.rs`).
///
/// - A function is refused unless the registration takes one.
/// - A method with one input (arity 2) reads several arguments as a sequence:
///   `.fast(2, 4)` is `.fast("2 4")`. No argument is refused, since a sequence
///   of nothing is silence and silences the chain.
/// - Any other count must match the arity.
/// - A bare `.osc()` stays argument free.
/// - `midi` and `serial` check their arguments first (see [`device_checks`])
///   and then take any count of arguments, as the engine runtime does. No
///   device opens here: the registration gives the pattern its output tag.
pub fn combinator_method(
    registration: &Callable,
    name: &str,
    receiver: Pattern,
    args: &[Arg],
) -> Result<Pattern, String> {
    let expected = registration.arity().saturating_sub(1);
    let device = matches!(name, "midi" | "serial");
    if device {
        device_checks(name, args)?;
    }
    let bare_osc = name == "osc" && args.is_empty();
    if !registration.takes_function() && args.iter().any(Arg::is_function) {
        return Err(format!(
            "Invalid argument: .{name}() does not accept a function"
        ));
    }
    let patterns = if bare_osc {
        Vec::new()
    } else if device {
        args.iter()
            .map(reify_bridged)
            .collect::<Result<Vec<_>, _>>()?
    } else if expected == 1 && args.len() != 1 {
        if args.is_empty() {
            return Err(expects(name, expected, 0));
        }
        vec![sequence_args(args)?]
    } else {
        let patterns = args
            .iter()
            .map(reify_bridged)
            .collect::<Result<Vec<_>, _>>()?;
        if patterns.len() != expected {
            return Err(expects(name, expected, patterns.len()));
        }
        patterns
    };
    Ok(registration.call(&patterns, receiver))
}

/// The argument checks of `.midi()` and `.serial()`. A double-quoted string
/// reaches the method as a pattern, parsed as mini-notation, so a port name
/// must be in single quotes.
///
/// Source: the method closure of `install_combinator` (`surface/mod.rs`).
fn device_checks(name: &str, args: &[Arg]) -> Result<(), String> {
    if name == "midi" {
        if args.len() > 2 {
            return Err(".midi() accepts at most a port and an options object".into());
        }
        if let Some(port) = args.first()
            && !matches!(port, Arg::Str(_) | Arg::Num(_) | Arg::Undefined)
        {
            return Err(".midi() needs a port name in SINGLE quotes - .midi('IAC Bus 1') - or an index, .midi(0). Double quotes are parsed as mini-notation before .midi() sees them, so the name never arrives. `rustel devices` lists what is plugged in.".into());
        }
        if let Some(options) = args.get(1)
            && !matches!(options, Arg::Undefined | Arg::Object(_))
        {
            return Err(".midi() options must be an object".into());
        }
    } else {
        if args.len() > 4 {
            return Err(".serial() accepts at most baud, sendcrc, singlecharids, and port.".into());
        }
        if let Some(port) = args.get(3)
            && !matches!(port, Arg::Str(_) | Arg::Undefined)
        {
            return Err(".serial() needs its port in SINGLE quotes - .serial(38400, 0, 0, '/dev/ttyUSB0'). Double quotes are parsed as mini-notation before .serial() sees them, so the name never arrives.".into());
        }
    }
    Ok(())
}

/// A registered combinator called as a free function. The pattern is the last
/// argument. The host curries the call, so this runs with all arguments.
///
/// Source: the free closure of `install_combinator`.
pub fn combinator_free(registration: &Callable, args: &[Arg]) -> Result<Pattern, String> {
    let mut patterns = args
        .iter()
        .map(reify_bridged)
        .collect::<Result<Vec<_>, _>>()?;
    let receiver = patterns.pop().unwrap_or_else(silence);
    Ok(registration.call(&patterns, receiver))
}

/// The three controls which take a literal string: the string is code, not
/// mini-notation. Source: `LITERAL_STRING_CONTROLS` (`install/pattern_bindings.rs`).
pub fn is_literal_control(name: &str) -> bool {
    matches!(name, "byteBeatExpression" | "bbexpr" | "bb")
}

/// A control called as a method of `receiver`.
///
/// Source: the method closure of the control loop (`install/pattern_bindings.rs`).
///
/// - A leading undefined argument is no argument. Trailing undefined
///   arguments are dropped, and the first undefined ends the list.
/// - A compound control (`limit`, `s`) with several arguments reads them by
///   position: `limit(-6, "hard")`.
/// - A control with no argument names the receiver's own values.
pub fn control_method(
    spec: &ControlSpec,
    literal: bool,
    receiver: Pattern,
    args: &[Arg],
) -> Result<Pattern, String> {
    let mut given = args.iter();
    let first = given.next().filter(|value| !value.is_undefined());
    let rest: Vec<&Arg> = given.take_while(|value| !value.is_undefined()).collect();
    if !rest.is_empty() && spec.names.len() > 1 {
        let parts = first
            .into_iter()
            .chain(rest)
            .map(reify_bridged)
            .collect::<Result<Vec<_>, _>>()?;
        return Ok(spec.apply_positional(&receiver, &parts));
    }
    let value = match first {
        None => None,
        Some(Arg::Str(text)) if literal => Some(pure(rustel_core::Value::Str(text.clone()))),
        Some(value) => Some(reify_bridged(value)?),
    };
    Ok(spec.apply(&receiver, value))
}

/// A control called as a free function: `gain(0.5)`.
///
/// Source: the free closure of the control loop. One argument is read.
pub fn control_free(spec: &ControlSpec, args: &[Arg]) -> Result<Pattern, String> {
    let value = reify_bridged(args.first().unwrap_or(&Arg::Undefined))?;
    Ok(spec.standalone(&value))
}

/// A composer operation under an alignment, as a method of `receiver`:
/// `pat.add(x)`, `pat.add.squeeze(x)`. No alignment means the current default.
///
/// Source: `compose_call` (`surface/mod.rs`) and the shortcut loop
/// (`install/pattern_bindings.rs`). The arguments are one sequence. An empty
/// call is refused: composing with nothing silences the chain.
pub fn composer(
    name: &str,
    op: ComposeOp,
    alignment: Option<Alignment>,
    receiver: &Pattern,
    args: &[Arg],
) -> Result<Pattern, String> {
    if args.is_empty() {
        return Err(expects(name, 1, 0));
    }
    let other = sequence_args(args)?;
    Ok(compose::compose(
        receiver,
        &other,
        op,
        alignment.unwrap_or_else(compose::default_alignment),
    ))
}
