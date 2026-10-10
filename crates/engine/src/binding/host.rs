//! The callback host. The pattern graph lives in the module and the score
//! functions live in the host, so a callback crosses the one import.
//!
//! ```text
//! pattern query             host                      score function
//!   call_value(id, v)
//!     encode v on tape
//!     host_call(0, id) ---> decode tape
//!                           functions[id](value) ---> an export call from
//!                                                     here re-enters the
//!                                                     module
//!     decode tape     <---  encode result
//! ```
//!
//! No Rust borrow is live across `host_call`. A throw never unwinds through
//! the import: the host turns the throw into an error return.

use crate::binding::reify::{reify_bridged, reify_list_element, value_of};
use crate::binding::state::{ATOMS, DEPTH, TABLE, TAPE, TAPE_CELLS, fail};
use crate::binding::table::Table;
use crate::binding::tape::{Arg, Cell, Writer, decode};
use rustel_core::{BindArg, BindResult, CallbackHost, CallbackId, Hap, Pattern, State, Value};

/// Run score function `id` on the value on the tape.
const KIND_VALUE: u32 = 0;
/// Run score function `id` on the pattern on the tape. The answer is a
/// pattern.
const KIND_PATTERN: u32 = 1;

/// Run score function `id` on the list on the tape, as its arguments. The
/// answer is any value. This is the call of a registered body.
const KIND_BODY: u32 = 2;

/// Score functions nest this deep at most, the limit of the engine's own
/// re-entry guard. One level takes several KiB of stack.
const MAX_DEPTH: u32 = 16;

#[cfg(target_arch = "wasm32")]
#[link(wasm_import_module = "binding")]
unsafe extern "C" {
    /// The host writes its answer at `tape`. A result is a cell count. A throw
    /// is `-(n + 1)` with `n` bytes of UTF-8 message at `tape`.
    fn host_call(kind: u32, id: u32, tape: *mut Cell, cells: u32) -> i32;
}

/// Outside wasm no host runs a score function.
#[cfg(not(target_arch = "wasm32"))]
unsafe fn host_call(_kind: u32, _id: u32, _tape: *mut Cell, _cells: u32) -> i32 {
    -1
}

pub struct WebHost;

pub static HOST: WebHost = WebHost;

const UNSUPPORTED: &str = "is not supported by the binding";

/// The first refusal of the binding. An engine node swallows the error of a
/// callback at times (a filter keeps its hap), so the refusal is also kept
/// here and the query reports the refusal.
fn refuse<T>(id: CallbackId, what: &str) -> Result<T, String> {
    let message = format!("callback {id}: {what} {UNSUPPORTED}");
    REFUSAL.with_borrow_mut(|refusal| {
        refusal.get_or_insert_with(|| message.clone());
    });
    Err(message)
}

/// The first refusal since the module started, if any.
pub fn refusal() -> Option<String> {
    REFUSAL.with_borrow(Clone::clone)
}

thread_local! {
    static REFUSAL: std::cell::RefCell<Option<String>> = const { std::cell::RefCell::new(None) };
}

impl CallbackHost for WebHost {
    fn call_value(&self, id: CallbackId, value: &Value) -> Result<Value, String> {
        let answer = cross(KIND_VALUE, id, |writer, table| writer.value(value, table))?;
        Ok(value_of(&answer))
    }

    fn call_pattern(&self, id: CallbackId, pattern: Pattern) -> Result<Pattern, String> {
        let answer = cross(KIND_PATTERN, id, |writer, table| {
            writer.pattern(table.insert(pattern))
        })?;
        match answer {
            Arg::Pattern(pattern) => Ok(pattern),
            _ => Err("pattern transformer did not return a pattern".into()),
        }
    }

    fn call_bind(&self, id: CallbackId, arg: BindArg<'_>) -> Result<BindResult, String> {
        // A bind callback is the body of a registered name, or a function of
        // the score. The body gets the collected values and the receiver.
        let body = body_at(id);
        let function = body.as_ref().map_or(id, |(function, _)| *function as usize);
        let answer = cross(KIND_BODY, function, |writer, table| {
            let values: Vec<&Value> = match (&arg, &body) {
                (BindArg::Value(Value::List(values)), Some(_)) => values.iter().collect(),
                (BindArg::Value(value), _) => vec![value],
                (BindArg::Pattern(_), _) => Vec::new(),
            };
            let patterns = match (&arg, &body) {
                (BindArg::Pattern(pattern), _) => Some(pattern.clone()),
                (_, Some((_, receiver))) => Some(receiver.clone()),
                _ => None,
            };
            writer.list(values.len() + usize::from(patterns.is_some()))?;
            for value in values {
                writer.value(value, table)?;
            }
            match patterns {
                Some(pattern) => writer.pattern(table.insert(pattern)),
                None => Ok(()),
            }
        })?;
        Ok(match answer {
            Arg::Pattern(pattern) => BindResult::Pattern(pattern),
            other => BindResult::Value(value_of(&other)),
        })
    }

    fn call_ref(&self, id: CallbackId) -> Result<Pattern, String> {
        refuse(id, "a reference accessor")
    }

    fn call_pick_lookup(&self, id: CallbackId) -> Result<rustel_core::PickLookup, String> {
        refuse(id, "a pick lookup")
    }

    fn call_materialize_value(&self, id: CallbackId) -> Result<Value, String> {
        refuse(id, "a host value")
    }

    fn call_query(&self, id: CallbackId, state: &State) -> Result<Vec<Hap>, String> {
        let answer = cross(KIND_VALUE, id, |writer, table| writer.state(state, table))?;
        haps_of(&answer)
    }

    /// `echoWith` and `plyForEach` hand each pattern and its index to the
    /// function. Every call runs first. The results become patterns after the
    /// last call. A later call changes an earlier result and the change shows.
    ///
    /// Source: `call_pattern_indexed_batch` (`runtime/callback_host.rs`).
    fn call_pattern_indexed_batch(
        &self,
        id: CallbackId,
        patterns: Vec<(Pattern, i64)>,
    ) -> Result<Vec<Pattern>, String> {
        let mut returned = Vec::with_capacity(patterns.len());
        for (pattern, index) in patterns {
            returned.push(cross(KIND_BODY, id, |writer, table| {
                writer.list(2)?;
                writer.pattern(table.insert(pattern))?;
                writer.number(index as f64)
            })?);
        }
        returned.iter().map(reify_list_element).collect()
    }

    /// `arpWith`: the function gets the haps of one chord as a list and
    /// answers a pattern or a value which reifies to one.
    fn call_haps(&self, id: CallbackId, haps: &[Hap]) -> Result<Pattern, String> {
        let answer = cross(KIND_VALUE, id, |writer, table| {
            writer.list(haps.len())?;
            haps.iter().try_for_each(|hap| writer.hap(hap, table))
        })?;
        reify_bridged(&answer)
    }

    fn call_hap_predicate(&self, id: CallbackId, hap: &Hap) -> Result<bool, String> {
        let answer = cross(KIND_VALUE, id, |writer, table| writer.hap(hap, table))?;
        Ok(answer.truthy())
    }

    fn call_time_predicate(
        &self,
        id: CallbackId,
        time: rustel_fraction::Fraction,
    ) -> Result<bool, String> {
        let answer = cross(KIND_VALUE, id, |writer, _| writer.fraction(time))?;
        Ok(answer.truthy())
    }

    fn call_span_transform(
        &self,
        id: CallbackId,
        span: rustel_core::TimeSpan,
    ) -> Result<rustel_core::TimeSpan, String> {
        let answer = cross(KIND_VALUE, id, |writer, _| writer.span(span))?;
        match answer {
            Arg::Span(span) => Ok(span),
            _ => Err("withQuerySpan callback did not return a TimeSpan".into()),
        }
    }
}

/// The haps a query function answers: real haps, or the compact shape
/// `{ begin, end, value }` whose whole is its part.
///
/// Source: `call_query_inner` (`runtime/callback_query.rs`). A hole, or an
/// item which is no object, is no hap.
fn haps_of(answer: &Arg) -> Result<Vec<Hap>, String> {
    let Arg::List(items) = answer else {
        return Err("query callback must return an array".into());
    };
    let mut haps = Vec::with_capacity(items.len());
    for item in items {
        match item {
            Arg::Hap(hap) => haps.push(hap.to_hap()),
            Arg::Object(members) => {
                let get = |name: &str| {
                    members
                        .iter()
                        .find(|(key, _)| key == name)
                        .map(|(_, value)| value)
                };
                let part = match get("part") {
                    Some(part) => part.span()?,
                    None => item.span()?,
                };
                let whole = match get("whole") {
                    None => Some(part),
                    Some(Arg::Undefined | Arg::Null) => None,
                    Some(span) => Some(span.span()?),
                };
                let hap = crate::binding::tape::HapArg {
                    whole,
                    part,
                    value: get("value").cloned().unwrap_or(Arg::Undefined),
                    context: get("context").cloned().unwrap_or(Arg::Undefined),
                };
                haps.push(hap.to_hap());
            }
            _ => {}
        }
    }
    Ok(haps)
}

/// One crossing: write the argument, call the host, read the answer.
fn cross(
    kind: u32,
    id: CallbackId,
    write: impl FnOnce(&mut Writer, &mut crate::binding::table::Table) -> Result<(), String>,
) -> Result<Arg, String> {
    if DEPTH.get() >= MAX_DEPTH {
        return Err("score functions nest too deep".into());
    }
    // A value the tape cannot carry is a refusal of the binding too.
    let note = |error: String| {
        if error.contains(UNSUPPORTED) {
            REFUSAL.with_borrow_mut(|refusal| {
                refusal.get_or_insert_with(|| error.clone());
            });
        }
        error
    };
    let (tape, cells) = TAPE
        .with_borrow_mut(|cells| {
            let tape = cells.as_mut_ptr();
            ATOMS.with_borrow_mut(|atoms| {
                TABLE.with_borrow_mut(|table| {
                    let mut writer = Writer::new(cells, atoms);
                    write(&mut writer, table).map(|()| (tape, writer.cells()))
                })
            })
        })
        .map_err(note)?;
    DEPTH.set(DEPTH.get() + 1);
    // SAFETY: `tape` points at `TAPE_CELLS` cells which never move, and no
    // borrow of them is live here.
    let answer = unsafe { host_call(kind, id as u32, tape, cells as u32) };
    DEPTH.set(DEPTH.get() - 1);
    if answer < 0 {
        return Err(TAPE.with_borrow(|cells| {
            let length = ((-(answer + 1)) as usize).min(TAPE_CELLS * 16);
            // SAFETY: the tape is `TAPE_CELLS * 16` bytes of ordinary data.
            let bytes = unsafe { std::slice::from_raw_parts(cells.as_ptr().cast::<u8>(), length) };
            String::from_utf8_lossy(bytes).into_owned()
        }));
    }
    TAPE.with_borrow(|cells| {
        let used = cells
            .get(..answer as usize)
            .ok_or("result is larger than the tape")?;
        ATOMS.with_borrow(|atoms| TABLE.with_borrow(|table| decode(used, atoms, table)))
    })
}

/// A failed export call reports its message here.
pub fn failed(message: impl Into<String>) -> u32 {
    fail(message.into())
}

/// The first id of the registered bodies. A body is a function of the score
/// with the pattern of the call as receiver. The ids of score functions stay below.
pub const BODY_BASE: usize = 1 << 30;

thread_local! {
    static BODIES: std::cell::RefCell<Vec<(u32, Pattern)>> = const { std::cell::RefCell::new(Vec::new()) };
}

/// Keep a registered body for a later query and return its id.
pub fn keep_body(function: u32, receiver: Pattern) -> CallbackId {
    BODIES.with_borrow_mut(|bodies| {
        bodies.push((function, receiver));
        BODY_BASE + bodies.len() - 1
    })
}

fn body_at(id: CallbackId) -> Option<(u32, Pattern)> {
    let at = id.checked_sub(BODY_BASE)?;
    BODIES.with_borrow(|bodies| bodies.get(at).cloned())
}

/// One argument of a call of a score function: a value or a pattern.
pub enum Item<'a> {
    Value(&'a Value),
    Pattern(&'a Pattern),
}

/// Call score function `function` with `items` and give back its answer.
pub fn call_body(function: u32, items: &[Item]) -> Result<Arg, String> {
    cross(
        KIND_BODY,
        function as usize,
        |writer: &mut Writer, table: &mut Table| {
            writer.list(items.len())?;
            for item in items {
                match item {
                    Item::Value(value) => writer.value(value, table)?,
                    Item::Pattern(pattern) => writer.pattern(table.insert((*pattern).clone()))?,
                }
            }
            Ok(())
        },
    )
}

/// Apply a score function from a pattern to a pattern.
pub fn call_function_on_pattern(function: u32, pattern: Pattern) -> Result<Pattern, String> {
    HOST.call_pattern(function as usize, pattern)
}
