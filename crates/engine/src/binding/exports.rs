//! The exports. Raw `extern "C"`, no generated glue.
//!
//! A call export reads its arguments from the tape as one list of
//! `cells` cells, runs, and returns a pattern handle. A failure returns
//! `u32::MAX` and leaves the message for `bind_last_error`.

use crate::binding::host::HOST;
use crate::binding::install::{self, COMBINATORS, CONTROLS, READS, SHORTCUTS};
use crate::binding::natives::{self, Call};
use crate::binding::reify::registry;
use crate::binding::rules;
use crate::binding::state::{
    ATOMS, LAST_ERROR, SCRATCH, TABLE, TAPE, TAPE_CELLS, fail, fill_scratch, keep, pattern,
};
use crate::binding::tape::{Arg, Cell, Writer, decode};
use rustel_core::compose::{Alignment, ComposeOp};
use rustel_core::{
    DEFAULT_HAP_BUDGET, Pattern, QueryArcOutcome, State, TimeSpan, with_callback_host,
};
use rustel_fraction::Fraction;
use std::cell::RefCell;

thread_local! {
    /// The context sum, and the thrown message, of the last query.
    static QUERY: RefCell<(f64, String)> = const { RefCell::new((0.0, String::new())) };
}

/// No receiver.
const NONE: u32 = u32::MAX;
/// The current default alignment.
const DEFAULT_ALIGNMENT: u32 = u32::MAX;

/// Keep the message of a panic. The module aborts after a panic, and the host
/// reads the message through `bind_last_error` from the trapped instance.
#[unsafe(no_mangle)]
pub extern "C" fn bind_init() {
    std::panic::set_hook(Box::new(|info| {
        let message = format!("panic: {info}");
        // A borrow is live at times when the panic hits. The message is lost then.
        let _ = LAST_ERROR.try_with(|last| last.try_borrow_mut().map(|mut last| *last = message));
    }));
}

/// The address of the tape. The address never changes.
#[unsafe(no_mangle)]
pub extern "C" fn bind_tape() -> *mut Cell {
    TAPE.with_borrow_mut(|cells| cells.as_mut_ptr())
}

/// Tape capacity in cells.
#[unsafe(no_mangle)]
pub extern "C" fn bind_tape_cells() -> u32 {
    TAPE_CELLS as u32
}

/// A buffer of at least `bytes` bytes. Valid until the next export call.
#[unsafe(no_mangle)]
pub extern "C" fn bind_scratch(bytes: u32) -> *mut u8 {
    SCRATCH.with_borrow_mut(|scratch| {
        if scratch.len() < bytes as usize {
            scratch.resize(bytes as usize, 0);
        }
        scratch.as_mut_ptr()
    })
}

/// Register the first `bytes` bytes of the scratch buffer as a string.
#[unsafe(no_mangle)]
pub extern "C" fn bind_intern(bytes: u32) -> u32 {
    SCRATCH.with_borrow(|scratch| {
        let text = String::from_utf8_lossy(&scratch[..(bytes as usize).min(scratch.len())]);
        ATOMS.with_borrow_mut(|atoms| atoms.intern(&text))
    })
}

/// Copy the text of `atom` into the scratch buffer. Returns its byte length,
/// or `u32::MAX` for an atom which does not exist.
#[unsafe(no_mangle)]
pub extern "C" fn bind_atom_name(atom: u32) -> u32 {
    ATOMS.with_borrow(|atoms| {
        atoms
            .name(atom)
            .map_or(u32::MAX, |name| fill_scratch(name.as_bytes()))
    })
}

/// Copy the message of the last failed call into the scratch buffer. Returns
/// its byte length.
#[unsafe(no_mangle)]
pub extern "C" fn bind_last_error() -> u32 {
    LAST_ERROR.with_borrow(|last| fill_scratch(last.as_bytes()))
}

/// Free a pattern handle. A handle which is not live is ignored.
#[unsafe(no_mangle)]
pub extern "C" fn bind_free(handle: u32) {
    TABLE.with_borrow_mut(|table| table.free(handle));
}

/// How many pattern handles are live.
#[unsafe(no_mangle)]
pub extern "C" fn bind_live() -> u32 {
    TABLE.with_borrow(|table| table.live() as u32)
}

/// Write the install list on the tape as one list of rows, five cells each:
/// kind, name, arity, flags, index. Returns the cell count.
#[unsafe(no_mangle)]
pub extern "C" fn bind_install_list() -> u32 {
    let rows = install::rows();
    let written = TAPE.with_borrow_mut(|cells| {
        ATOMS.with_borrow_mut(|atoms| {
            let mut writer = Writer::new(cells, atoms);
            writer.list(rows.len() * 5)?;
            for row in &rows {
                writer.number(f64::from(row.kind))?;
                writer.text(&row.name)?;
                writer.number(f64::from(row.arity))?;
                writer.number(f64::from(row.flags))?;
                writer.number(f64::from(row.index))?;
            }
            Ok::<_, String>(writer.cells() as u32)
        })
    });
    written.unwrap_or_else(fail)
}

/// Read the arguments from the tape.
fn read_args(cells: u32) -> Result<Vec<Arg>, String> {
    let arg = TAPE.with_borrow(|tape| {
        let used = tape
            .get(..cells as usize)
            .ok_or("argument list is larger than the tape")?;
        ATOMS.with_borrow(|atoms| TABLE.with_borrow(|table| decode(used, atoms, table)))
    })?;
    match arg {
        Arg::List(items) => Ok(items),
        _ => Err("arguments are a list".into()),
    }
}

/// Run a call. The callback host is installed for the whole call, since a
/// registered method applies a score function at once.
fn call(
    cells: u32,
    receiver: u32,
    run: impl FnOnce(Option<&Pattern>, &[Arg]) -> Result<Pattern, String>,
) -> u32 {
    let args = match read_args(cells) {
        Ok(args) => args,
        Err(error) => return fail(error),
    };
    let receiver = if receiver == NONE {
        None
    } else {
        match pattern(receiver) {
            Some(pattern) => Some(pattern),
            None => return fail("pattern handle is not live".into()),
        }
    };
    let result = with_callback_host(&HOST, || run(receiver.as_ref(), &args));
    match result {
        Ok(result) => {
            // A score function which threw while a method applied the function
            // at once is a throw of this call, as the engine runtime
            // rethrows the error. Inside a callback the enclosing query takes
            // the error.
            if crate::binding::state::DEPTH.get() == 0
                && let Some(error) = rustel_core::take_query_error()
            {
                return fail(error);
            }
            keep(result)
        }
        Err(error) => fail(error),
    }
}

/// A registered combinator. `free` is 0 for a method, 1 for the free form.
#[unsafe(no_mangle)]
pub extern "C" fn bind_call_combinator(index: u32, receiver: u32, cells: u32, free: u32) -> u32 {
    let Some((name, registration)) = COMBINATORS.get(index as usize) else {
        return fail("unknown combinator".into());
    };
    call(cells, receiver, |receiver, args| match receiver {
        Some(receiver) if free == 0 => {
            rules::combinator_method(registration, name, receiver.clone(), args)
        }
        _ => rules::combinator_free(registration, args),
    })
}

/// A control. `free` is 0 for a method, 1 for the free form.
#[unsafe(no_mangle)]
pub extern "C" fn bind_call_control(index: u32, receiver: u32, cells: u32, free: u32) -> u32 {
    let Some((name, spec)) = CONTROLS.get(index as usize) else {
        return fail("unknown control".into());
    };
    call(cells, receiver, |receiver, args| match receiver {
        Some(receiver) if free == 0 => rules::control_method(
            spec,
            rules::is_literal_control(name),
            receiver.clone(),
            args,
        ),
        _ => rules::control_free(spec, args),
    })
}

/// A composer operation under an alignment, as `pat.add(x)` or
/// `pat.add.squeeze(x)`.
#[unsafe(no_mangle)]
pub extern "C" fn bind_call_composer(op: u32, alignment: u32, receiver: u32, cells: u32) -> u32 {
    let Some(op) = ComposeOp::ALL.get(op as usize).copied() else {
        return fail("unknown composer".into());
    };
    let alignment = if alignment == DEFAULT_ALIGNMENT {
        None
    } else {
        Alignment::ALL.get(alignment as usize).copied()
    };
    call(cells, receiver, |receiver, args| {
        rules::composer(
            op.name(),
            op,
            alignment,
            receiver.ok_or("a composer needs a pattern")?,
            args,
        )
    })
}

/// A method which composes under a fixed alignment, such as `struct`.
#[unsafe(no_mangle)]
pub extern "C" fn bind_call_shortcut(index: u32, receiver: u32, cells: u32) -> u32 {
    let Some(shortcut) = SHORTCUTS.get(index as usize) else {
        return fail("unknown shortcut".into());
    };
    call(cells, receiver, |receiver, args| {
        rules::composer(
            shortcut.name,
            shortcut.op,
            Some(shortcut.alignment),
            receiver.ok_or("a shortcut needs a pattern")?,
            args,
        )
    })
}

/// A pattern value: a signal, `silence`.
#[unsafe(no_mangle)]
pub extern "C" fn bind_read(index: u32) -> u32 {
    match READS.get(index as usize) {
        Some((_, pattern)) => keep(pattern.clone()),
        None => fail("unknown value".into()),
    }
}

/// A hand-written name.
#[unsafe(no_mangle)]
pub extern "C" fn bind_call_native(index: u32, receiver: u32, cells: u32) -> u32 {
    let Some(native) = natives::TABLE.get(index as usize) else {
        return fail("unknown native".into());
    };
    call(cells, receiver, |receiver, args| {
        (native.run)(&Call {
            this: receiver,
            args,
        })
    })
}

/// Query whole cycles `begin` to `end`. The sorted `show()` lines, one per hap
/// with a newline after each, are in the scratch buffer. Returns the hap
/// count. A query which threw has no haps, and `bind_query_thrown` gives the
/// message.
#[unsafe(no_mangle)]
pub extern "C" fn bind_query(handle: u32, begin: i32, end: i32) -> u32 {
    QUERY.with_borrow_mut(|query| *query = (0.0, String::new()));
    let Some(pattern) = pattern(handle) else {
        return fail("pattern handle is not live".into());
    };
    let outcome = with_callback_host(&HOST, || {
        let state = State::new(TimeSpan::new(
            Fraction::from(i64::from(begin)),
            Fraction::from(i64::from(end)),
        ));
        pattern.query_arc_outcome_with_budget(&state, DEFAULT_HAP_BUDGET)
    });
    let haps = match outcome {
        Ok(QueryArcOutcome::Haps(haps)) => rustel_core::sort_haps_for_query(haps),
        Ok(QueryArcOutcome::Thrown(message)) => {
            QUERY.with_borrow_mut(|query| query.1 = message);
            Vec::new()
        }
        Err(limit) => {
            QUERY.with_borrow_mut(|query| query.1 = format!("{limit:?}"));
            Vec::new()
        }
    };
    let mut text = String::new();
    let mut context = 0_usize;
    for hap in &haps {
        text.push_str(&hap.show());
        text.push('\n');
        context += hap.context.len();
    }
    QUERY.with_borrow_mut(|query| query.0 = context as f64);
    fill_scratch(text.as_bytes());
    haps.len() as u32
}

/// The byte length of the text in the scratch buffer.
#[unsafe(no_mangle)]
pub extern "C" fn bind_scratch_len() -> u32 {
    SCRATCH.with_borrow(|scratch| scratch.len() as u32)
}

/// The sum of the context lengths of the haps of the last query.
#[unsafe(no_mangle)]
pub extern "C" fn bind_query_context() -> f64 {
    QUERY.with_borrow(|query| query.0)
}

/// Copy the message the last query threw into the scratch buffer. Returns its
/// byte length, 0 when the query did not throw.
#[unsafe(no_mangle)]
pub extern "C" fn bind_query_thrown() -> u32 {
    let thrown = QUERY.with_borrow(|query| query.1.clone());
    // The engine node which asked swallows a refusal of the binding at times,
    // so the refusal counts here too.
    let message = if thrown.is_empty() {
        crate::binding::host::refusal().unwrap_or_default()
    } else {
        thrown
    };
    fill_scratch(message.as_bytes())
}

/// The registered names of the engine, for a check of the install list.
#[unsafe(no_mangle)]
pub extern "C" fn bind_registered() -> u32 {
    registry().len() as u32
}

/// Read the value on the tape and write the value back. The host tests its
/// codec with this export: every tag comes back as sent. Returns the cell
/// count.
#[unsafe(no_mangle)]
pub extern "C" fn bind_echo(cells: u32) -> u32 {
    let arg = match TAPE.with_borrow(|tape| {
        let used = tape
            .get(..cells as usize)
            .ok_or("value is larger than the tape")?;
        ATOMS.with_borrow(|atoms| TABLE.with_borrow(|table| decode(used, atoms, table)))
    }) {
        Ok(arg) => arg,
        Err(error) => return fail(error),
    };
    TAPE.with_borrow_mut(|tape| {
        ATOMS.with_borrow_mut(|atoms| {
            TABLE.with_borrow_mut(|table| {
                let mut writer = Writer::new(tape, atoms);
                writer
                    .arg(&arg, table)
                    .map(|()| writer.cells() as u32)
                    .unwrap_or_else(fail)
            })
        })
    })
}

/// A name which sets a setting and answers nothing. Returns 0, or
/// `u32::MAX` for a failure.
#[unsafe(no_mangle)]
pub extern "C" fn bind_call_effect(index: u32, cells: u32) -> u32 {
    let Some(effect) = natives::EFFECTS.get(index as usize) else {
        return fail("unknown effect".into());
    };
    match read_args(cells).and_then(|args| (effect.run)(&args)) {
        Ok(()) => 0,
        Err(error) => fail(error),
    }
}

/// A name which answers a value. The value is on the tape after the call.
/// Returns the cell count, or `u32::MAX` for a failure.
#[unsafe(no_mangle)]
pub extern "C" fn bind_call_value(index: u32, cells: u32) -> u32 {
    let Some(value) = crate::binding::generators::VALUES.get(index as usize) else {
        return fail("unknown value function".into());
    };
    let answer = read_args(cells).and_then(|args| (value.run)(&args));
    match answer {
        Ok(answer) => TAPE
            .with_borrow_mut(|tape| {
                ATOMS.with_borrow_mut(|atoms| {
                    TABLE.with_borrow_mut(|table| {
                        let mut writer = Writer::new(tape, atoms);
                        writer.value(&answer, table).map(|()| writer.cells() as u32)
                    })
                })
            })
            .unwrap_or_else(fail),
        Err(error) => fail(error),
    }
}

/// Start a score: the offsets of `timeline` and the default alignment go back
/// to their start.
#[unsafe(no_mangle)]
pub extern "C" fn bind_begin_score() {
    crate::binding::generators::begin_score();
}

/// A name the score registered. `flags` holds `PATTERNIFY` and
/// `PRESERVE_STEPS`. `join` is a function id, or `u32::MAX` for none.
#[unsafe(no_mangle)]
pub extern "C" fn bind_call_registered(
    function: u32,
    arity: i32,
    flags: u32,
    join: u32,
    name: u32,
    receiver: u32,
    cells: u32,
) -> u32 {
    let name = ATOMS.with_borrow(|atoms| atoms.name(name).map(str::to_owned));
    let Some(name) = name else {
        return fail("unknown name".into());
    };
    call(cells, receiver, |receiver, args| {
        let registered = crate::binding::registered::Registered {
            name: &name,
            function,
            arity: i64::from(arity),
            flags,
            join: (join != NONE).then_some(join),
        };
        crate::binding::registered::call(&registered, receiver, args)
    })
}

/// A pattern from a query function of the score: `new Pattern(query, steps)`.
/// The arguments are `[steps]`. Returns a handle.
///
/// Source: `pattern_implementation` (`surface/setup/pattern_surface.rs`).
#[unsafe(no_mangle)]
pub extern "C" fn bind_pattern_from_query(function: u32, cells: u32) -> u32 {
    call(cells, NONE, |_, args| {
        let steps = match args.first() {
            None | Some(Arg::Undefined) => None,
            Some(value) => Some(value.fraction()?),
        };
        Ok(rustel_core::js_query(function as usize).with_steps(steps))
    })
}

/// The haps a pattern gives for a state: `pattern.query(state)`. The arguments
/// are `[state]`, and the answer is a list of haps on the tape. Returns the
/// cell count.
#[unsafe(no_mangle)]
pub extern "C" fn bind_query_state(handle: u32, cells: u32) -> u32 {
    let Some(pattern) = pattern(handle) else {
        return fail("pattern handle is not live".into());
    };
    let state = match read_args(cells) {
        Ok(args) => match args.into_iter().next() {
            Some(Arg::State(state)) => state,
            _ => return fail("Pattern.query requires a State".into()),
        },
        Err(error) => return fail(error),
    };
    let mut engine_state = State::new(state.span);
    if let Arg::Object(controls) = &state.controls {
        for (key, value) in controls {
            engine_state
                .controls
                .insert(key.clone(), crate::binding::reify::value_of(value));
        }
    }
    let haps = with_callback_host(&HOST, || pattern.query(&engine_state));
    TAPE.with_borrow_mut(|tape| {
        ATOMS.with_borrow_mut(|atoms| {
            TABLE.with_borrow_mut(|table| {
                let mut writer = Writer::new(tape, atoms);
                writer.list(haps.len())?;
                haps.iter().try_for_each(|hap| writer.hap(hap, table))?;
                Ok::<_, String>(writer.cells() as u32)
            })
        })
    })
    .unwrap_or_else(fail)
}
