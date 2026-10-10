//! The value tape and the atom table.
//!
//! A value crosses as a run of 16-byte cells in pre-order. A list, an object
//! or a function reference is one head cell with its child count, then its
//! children. A child of an object carries the atom of its key.
//!
//! ```text
//! byte  0      1      2..4   4..8       8..16
//!       tag    flags  pad    key atom   payload
//! ```
//!
//! Payload by tag:
//!
//! | Tag | Payload |
//! |---|---|
//! | `F64` | the number |
//! | `BOOL` | 0 or 1 in the first byte |
//! | `STR` | an atom, u32 |
//! | `LIST`, `OBJECT` | the child count, u32 |
//! | `PATTERN` | a pattern handle, u32 |
//! | `FUNC` | a callback id, u32 |
//! | `REF` | a callback id, u32, then the child count, u32 |
//! | `I64` | a signed 64-bit integer |
//! | `FRAC` | the child count, u32: two `I64` (numerator with sign, denominator) or one `STR` (`n/d`, for a part past 64 bits) |
//! | `SPAN` | two `FRAC` children: begin, end |
//! | `HAP` | five children: whole (`SPAN` or `UNDEFINED`), part (`SPAN`), value, context, stateful |
//! | `STATE` | two children: span (`SPAN`), controls (an `OBJECT`) |
//!
//! A `REF` is a function the host tagged as a named combinator with its
//! collected arguments. The first child is the name as a `STR`, the others
//! are the arguments. The callback id stays valid, so a rule which cannot use
//! a reference falls back to the function.
//!
//! A string never crosses inside the tape. Each side maps a string to a u32
//! atom. The table lives here. The host asks for the text of an atom unknown
//! to the host, once, and registers a string unknown to this side, once.
//! All fields are little endian.

use crate::binding::table::Table;
use rustel_core::value::PatternValue;
use rustel_core::{Hap, OrderedMap, Pattern, State, TimeSpan, Value};
use rustel_fraction::Fraction;
use std::collections::HashMap;
use std::hash::{BuildHasherDefault, Hasher};

pub const UNDEFINED: u8 = 0;
pub const NULL: u8 = 1;
pub const BOOL: u8 = 2;
pub const F64: u8 = 3;
pub const STR: u8 = 4;
pub const LIST: u8 = 5;
pub const OBJECT: u8 = 6;
pub const PATTERN: u8 = 7;
pub const FUNC: u8 = 8;
pub const REF: u8 = 9;
pub const I64: u8 = 10;
pub const FRAC: u8 = 11;
pub const SPAN: u8 = 12;
pub const HAP: u8 = 13;
pub const STATE: u8 = 14;

/// Flag bit 0: the cell is a member of an object and `key` is valid.
pub const KEYED: u8 = 1;

/// Lists and objects nest this deep at most. Encode and decode recurse once
/// per level, and the limit keeps the recursion far from the stack size.
pub const MAX_DEPTH: u32 = 64;

/// One tape cell. Size 16, alignment 8, so a 64-bit float view lines up.
#[repr(C, align(8))]
#[derive(Clone, Copy, Default, Debug, PartialEq)]
pub struct Cell {
    pub tag: u8,
    pub flags: u8,
    pub pad: u16,
    pub key: u32,
    pub payload: [u8; 8],
}

impl Cell {
    pub fn new(tag: u8, payload: [u8; 8]) -> Self {
        Self {
            tag,
            flags: 0,
            pad: 0,
            key: 0,
            payload,
        }
    }

    /// The first payload word.
    pub fn word(self) -> u32 {
        u32::from_le_bytes([
            self.payload[0],
            self.payload[1],
            self.payload[2],
            self.payload[3],
        ])
    }

    /// The second payload word.
    pub fn second_word(self) -> u32 {
        u32::from_le_bytes([
            self.payload[4],
            self.payload[5],
            self.payload[6],
            self.payload[7],
        ])
    }
}

/// A payload of two words.
pub fn words(first: u32, second: u32) -> [u8; 8] {
    let mut payload = [0_u8; 8];
    payload[..4].copy_from_slice(&first.to_le_bytes());
    payload[4..].copy_from_slice(&second.to_le_bytes());
    payload
}

/// FNV-1a. The keys are short names, so a byte loop beats SipHash.
pub struct Fnv(u32);

impl Default for Fnv {
    fn default() -> Self {
        Self(0x811c_9dc5)
    }
}

impl Hasher for Fnv {
    fn write(&mut self, bytes: &[u8]) {
        for byte in bytes {
            self.0 = (self.0 ^ u32::from(*byte)).wrapping_mul(0x0100_0193);
        }
    }

    fn finish(&self) -> u64 {
        u64::from(self.0)
    }
}

/// The two-way string table. An atom is an index into `names`.
#[derive(Default)]
pub struct Atoms {
    names: Vec<Box<str>>,
    ids: HashMap<Box<str>, u32, BuildHasherDefault<Fnv>>,
}

impl Atoms {
    pub fn intern(&mut self, text: &str) -> u32 {
        if let Some(atom) = self.ids.get(text) {
            return *atom;
        }
        let atom = self.names.len() as u32;
        self.names.push(text.into());
        self.ids.insert(text.into(), atom);
        atom
    }

    pub fn name(&self, atom: u32) -> Option<&str> {
        self.names.get(atom as usize).map(|name| &**name)
    }

    fn text(&self, atom: u32) -> Result<&str, String> {
        self.name(atom)
            .ok_or_else(|| format!("unknown atom {atom}"))
    }

    pub fn len(&self) -> usize {
        self.names.len()
    }

    pub fn is_empty(&self) -> bool {
        self.names.is_empty()
    }
}

/// What the host sent, read off the tape. A pattern handle is already
/// resolved, so a freed handle fails while the call is read.
#[derive(Clone)]
pub enum Arg {
    Undefined,
    Null,
    Bool(bool),
    Num(f64),
    Str(String),
    List(Vec<Arg>),
    Object(Vec<(String, Arg)>),
    Pattern(Pattern),
    Func(Func),
    /// An exact time value.
    Frac(Fraction),
    Span(TimeSpan),
    Hap(Box<HapArg>),
    State(Box<StateArg>),
}

/// A hap in the host form. The value and the context stay host values.
#[derive(Clone)]
pub struct HapArg {
    pub whole: Option<TimeSpan>,
    pub part: TimeSpan,
    pub value: Arg,
    pub context: Arg,
}

/// A state in the host form.
#[derive(Clone)]
pub struct StateArg {
    pub span: TimeSpan,
    pub controls: Arg,
}

/// A function of the host.
#[derive(Clone)]
pub struct Func {
    /// The id the host knows the function by.
    pub id: u32,
    /// The named combinator and its collected arguments, when the host tagged
    /// the function.
    pub reference: Option<(String, Vec<Arg>)>,
}

impl Arg {
    pub fn is_undefined(&self) -> bool {
        matches!(self, Arg::Undefined)
    }

    pub fn is_function(&self) -> bool {
        matches!(self, Arg::Func(_))
    }

    pub fn as_str(&self) -> Option<&str> {
        match self {
            Arg::Str(text) => Some(text),
            _ => None,
        }
    }

    pub fn as_number(&self) -> Option<f64> {
        match self {
            Arg::Num(number) => Some(*number),
            _ => None,
        }
    }

    /// A time value: an exact fraction, or a number read as the engine reads
    /// a number (`Fraction(number)` is a Farey search).
    pub fn fraction(&self) -> Result<Fraction, String> {
        match self {
            Arg::Frac(fraction) => Ok(*fraction),
            Arg::Num(number) => Fraction::from_f64(*number).ok_or_else(|| {
                "the time is not a finite number representable as a fraction".to_owned()
            }),
            _ => Err("a time value is a fraction or a number".into()),
        }
    }

    /// A time span: an exact span, or an object with `begin` and `end`.
    pub fn span(&self) -> Result<TimeSpan, String> {
        match self {
            Arg::Span(span) => Ok(*span),
            Arg::Object(members) => {
                let get = |name: &str| {
                    members
                        .iter()
                        .find_map(|(key, value)| (key == name).then_some(value))
                        .unwrap_or(&Arg::Undefined)
                };
                Ok(TimeSpan::new(
                    get("begin").fraction()?,
                    get("end").fraction()?,
                ))
            }
            _ => Err("a time span has a begin and an end".into()),
        }
    }

    /// The truthiness of a value: what `Boolean(x)` answers.
    pub fn truthy(&self) -> bool {
        match self {
            Arg::Undefined | Arg::Null => false,
            Arg::Bool(flag) => *flag,
            Arg::Num(number) => *number != 0.0 && !number.is_nan(),
            Arg::Str(text) => !text.is_empty(),
            _ => true,
        }
    }
}

impl HapArg {
    /// The engine hap: the span of its source in the context, and the side
    /// channels the engine reads back (`edoSize`, `logLine`).
    ///
    /// Source: `call_query_inner` (`runtime/callback_query.rs`).
    pub fn to_hap(&self) -> Hap {
        let mut locations = Vec::new();
        let mut edo_size = None;
        let mut log_line = None;
        if let Arg::Object(context) = &self.context {
            for (key, value) in context {
                match (key.as_str(), value) {
                    ("locations", Arg::List(items)) => {
                        for item in items {
                            if let Arg::Object(location) = item {
                                let number = |name: &str| {
                                    location.iter().find_map(|(key, value)| {
                                        (key == name).then(|| value.as_number()).flatten()
                                    })
                                };
                                if let (Some(start), Some(end)) = (number("start"), number("end")) {
                                    locations.push((start as usize, end as usize));
                                }
                            }
                        }
                    }
                    ("edoSize", Arg::Num(number)) => edo_size = Some(*number),
                    ("edoSize", Arg::Str(text)) => edo_size = text.parse().ok(),
                    ("logLine", Arg::Str(line)) => log_line = Some(line.clone()),
                    _ => {}
                }
            }
        }
        let mut hap = Hap::new(
            self.whole,
            self.part,
            crate::binding::reify::value_of(&self.value),
        )
        .with_context(locations);
        if let Some(size) = edo_size {
            hap = hap.with_edo_size_context(size);
        }
        if let Some(line) = log_line {
            hap = hap.with_log_line_context(line);
        }
        hap
    }
}

/// Read one value from the start of `tape`. Every cell must be used.
pub fn decode(tape: &[Cell], atoms: &Atoms, table: &Table) -> Result<Arg, String> {
    let mut at = 0;
    let value = take(tape, &mut at, atoms, table, 0)?;
    if at == tape.len() {
        Ok(value)
    } else {
        Err("tape has cells after its value".into())
    }
}

fn take(
    tape: &[Cell],
    at: &mut usize,
    atoms: &Atoms,
    table: &Table,
    depth: u32,
) -> Result<Arg, String> {
    let cell = *tape.get(*at).ok_or("tape ends inside a value")?;
    if depth > MAX_DEPTH {
        return Err("value nests too deep for the tape".into());
    }
    *at += 1;
    Ok(match cell.tag {
        UNDEFINED => Arg::Undefined,
        NULL => Arg::Null,
        BOOL => Arg::Bool(cell.payload[0] != 0),
        F64 => Arg::Num(f64::from_le_bytes(cell.payload)),
        STR => Arg::Str(atoms.text(cell.word())?.into()),
        PATTERN => Arg::Pattern(table.get(cell.word()).ok_or("pattern handle is not live")?),
        FUNC => Arg::Func(Func {
            id: cell.word(),
            reference: None,
        }),
        LIST => {
            let count = cell.word() as usize;
            // The count comes from the other side. Trust the tape length.
            let mut items = Vec::with_capacity(count.min(tape.len() - *at));
            for _ in 0..count {
                items.push(take(tape, at, atoms, table, depth + 1)?);
            }
            Arg::List(items)
        }
        OBJECT => {
            let count = cell.word() as usize;
            let mut members = Vec::with_capacity(count.min(tape.len() - *at));
            for _ in 0..count {
                let key = tape.get(*at).ok_or("tape ends inside an object")?.key;
                let name = atoms.text(key)?.to_string();
                members.push((name, take(tape, at, atoms, table, depth + 1)?));
            }
            Arg::Object(members)
        }
        REF => {
            let count = cell.second_word() as usize;
            let name = match take(tape, at, atoms, table, depth + 1)? {
                Arg::Str(name) => name,
                _ => return Err("a function reference starts with its name".into()),
            };
            let mut bound = Vec::with_capacity(count.saturating_sub(1).min(tape.len() - *at));
            for _ in 1..count {
                bound.push(take(tape, at, atoms, table, depth + 1)?);
            }
            Arg::Func(Func {
                id: cell.word(),
                reference: Some((name, bound)),
            })
        }
        I64 => Arg::Num(i64::from_le_bytes(cell.payload) as f64),
        FRAC => {
            let fraction = if cell.word() == 1 {
                let Arg::Str(text) = take(tape, at, atoms, table, depth + 1)? else {
                    return Err("a wide fraction holds its text".into());
                };
                let (numer, denom) = text.split_once('/').ok_or("a wide fraction reads n/d")?;
                let numer = numer.parse::<i128>().map_err(|error| error.to_string())?;
                let denom = denom.parse::<i128>().map_err(|error| error.to_string())?;
                Fraction::checked_new(numer, denom)
            } else {
                let mut parts = [0_i64; 2];
                for part in &mut parts {
                    let cell = *tape.get(*at).ok_or("tape ends inside a fraction")?;
                    *at += 1;
                    *part = i64::from_le_bytes(cell.payload);
                }
                Fraction::checked_new(i128::from(parts[0]), i128::from(parts[1]))
            };
            Arg::Frac(fraction.ok_or("a fraction needs a denominator")?)
        }
        SPAN => {
            let begin = take(tape, at, atoms, table, depth + 1)?;
            let end = take(tape, at, atoms, table, depth + 1)?;
            Arg::Span(TimeSpan::new(begin.fraction()?, end.fraction()?))
        }
        HAP => {
            let whole = take(tape, at, atoms, table, depth + 1)?;
            let part = take(tape, at, atoms, table, depth + 1)?;
            let value = take(tape, at, atoms, table, depth + 1)?;
            let context = take(tape, at, atoms, table, depth + 1)?;
            let _stateful = take(tape, at, atoms, table, depth + 1)?;
            Arg::Hap(Box::new(HapArg {
                whole: match whole {
                    Arg::Span(span) => Some(span),
                    _ => None,
                },
                part: part.span()?,
                value,
                context,
            }))
        }
        STATE => {
            let span = take(tape, at, atoms, table, depth + 1)?.span()?;
            let controls = take(tape, at, atoms, table, depth + 1)?;
            Arg::State(Box::new(StateArg { span, controls }))
        }
        tag => return Err(format!("unknown tape tag {tag}")),
    })
}

/// Writes cells from the start of a tape.
pub struct Writer<'a> {
    tape: &'a mut [Cell],
    atoms: &'a mut Atoms,
    at: usize,
}

impl<'a> Writer<'a> {
    pub fn new(tape: &'a mut [Cell], atoms: &'a mut Atoms) -> Self {
        Self { tape, atoms, at: 0 }
    }

    /// The cell count written so far.
    pub fn cells(&self) -> usize {
        self.at
    }

    fn push(&mut self, cell: Cell) -> Result<(), String> {
        let slot = self
            .tape
            .get_mut(self.at)
            .ok_or("value is larger than the tape")?;
        *slot = cell;
        self.at += 1;
        Ok(())
    }

    pub fn number(&mut self, number: f64) -> Result<(), String> {
        self.push(Cell::new(F64, number.to_le_bytes()))
    }

    pub fn boolean(&mut self, flag: bool) -> Result<(), String> {
        self.push(Cell::new(BOOL, words(u32::from(flag), 0)))
    }

    pub fn text(&mut self, text: &str) -> Result<(), String> {
        let atom = self.atoms.intern(text);
        self.push(Cell::new(STR, words(atom, 0)))
    }

    pub fn pattern(&mut self, handle: u32) -> Result<(), String> {
        self.push(Cell::new(PATTERN, words(handle, 0)))
    }

    /// An exact fraction. A part past 64 bits crosses as text.
    pub fn fraction(&mut self, fraction: Fraction) -> Result<(), String> {
        let (numer, denom) = (fraction.numer(), fraction.denom());
        match (i64::try_from(numer), i64::try_from(denom)) {
            (Ok(numer), Ok(denom)) => {
                self.push(Cell::new(FRAC, words(2, 0)))?;
                self.push(Cell::new(I64, numer.to_le_bytes()))?;
                self.push(Cell::new(I64, denom.to_le_bytes()))
            }
            _ => {
                self.push(Cell::new(FRAC, words(1, 0)))?;
                self.text(&format!("{numer}/{denom}"))
            }
        }
    }

    pub fn span(&mut self, span: TimeSpan) -> Result<(), String> {
        self.push(Cell::new(SPAN, words(2, 0)))?;
        self.fraction(span.begin)?;
        self.fraction(span.end)
    }

    /// A hap with the context of the engine.
    ///
    /// Source: `callback_hap` and `hap_context_to_js` (`value.rs`).
    pub fn hap(&mut self, hap: &Hap, table: &mut Table) -> Result<(), String> {
        self.push(Cell::new(HAP, words(5, 0)))?;
        match hap.whole {
            Some(whole) => self.span(whole)?,
            None => self.push(Cell::new(UNDEFINED, [0; 8]))?,
        }
        self.span(hap.part)?;
        self.value(&hap.value, table)?;
        let mut context = vec![(
            "locations".to_owned(),
            Value::List(
                hap.context
                    .iter()
                    .map(|(start, end)| {
                        Value::object([
                            ("start".to_owned(), Value::F64(*start as f64)),
                            ("end".to_owned(), Value::F64(*end as f64)),
                        ])
                    })
                    .collect(),
            ),
        )];
        if let Some(size) = hap.edo_size_context() {
            context.push(("edoSize".to_owned(), Value::F64(size)));
        }
        if let Some(tags) = hap.tags_context() {
            let tags = tags.iter().map(|tag| Value::Str(tag.to_string())).collect();
            context.push(("tags".to_owned(), Value::List(tags)));
        }
        if let Some(definition) = hap.scale_definition_context() {
            context.push(("scaleDefinition".to_owned(), definition.clone()));
        }
        if let Some(line) = hap.log_line() {
            context.push(("logLine".to_owned(), Value::Str(line.to_owned())));
        }
        self.value(&Value::object(context), table)?;
        self.boolean(false)
    }

    pub fn state(&mut self, state: &State, table: &mut Table) -> Result<(), String> {
        self.push(Cell::new(STATE, words(2, 0)))?;
        self.span(state.span)?;
        self.value(&Value::Object(state.controls.clone()), table)
    }

    /// A list head. The caller writes `count` children next.
    pub fn list(&mut self, count: usize) -> Result<(), String> {
        self.push(Cell::new(LIST, words(count as u32, 0)))
    }

    /// Write a value read off the tape, for the echo check of the host codec.
    /// A pattern gets a new handle in `table`.
    pub fn arg(&mut self, arg: &Arg, table: &mut Table) -> Result<(), String> {
        match arg {
            Arg::Undefined => self.push(Cell::new(UNDEFINED, [0; 8])),
            Arg::Null => self.push(Cell::new(NULL, [0; 8])),
            Arg::Bool(flag) => self.boolean(*flag),
            Arg::Num(number) => self.number(*number),
            Arg::Str(text) => self.text(text),
            Arg::Pattern(pattern) => self.pattern(table.insert(pattern.clone())),
            Arg::List(items) => {
                self.list(items.len())?;
                items.iter().try_for_each(|item| self.arg(item, table))
            }
            Arg::Object(members) => {
                let head = self.at;
                self.push(Cell::new(OBJECT, words(members.len() as u32, 0)))?;
                for (name, member) in members {
                    let key = self.atoms.intern(name);
                    let child = self.at;
                    self.arg(member, table)?;
                    self.tape[child].flags |= KEYED;
                    self.tape[child].key = key;
                }
                debug_assert_eq!(self.tape[head].tag, OBJECT);
                Ok(())
            }
            Arg::Frac(fraction) => self.fraction(*fraction),
            Arg::Span(span) => self.span(*span),
            Arg::Hap(hap) => {
                self.push(Cell::new(HAP, words(5, 0)))?;
                match hap.whole {
                    Some(whole) => self.span(whole)?,
                    None => self.push(Cell::new(UNDEFINED, [0; 8]))?,
                }
                self.span(hap.part)?;
                self.arg(&hap.value, table)?;
                self.arg(&hap.context, table)?;
                self.boolean(false)
            }
            Arg::State(state) => {
                self.push(Cell::new(STATE, words(2, 0)))?;
                self.span(state.span)?;
                self.arg(&state.controls, table)
            }
            Arg::Func(Func {
                id,
                reference: None,
            }) => self.push(Cell::new(FUNC, words(*id, 0))),
            Arg::Func(Func {
                id,
                reference: Some((name, bound)),
            }) => {
                self.push(Cell::new(REF, words(*id, bound.len() as u32 + 1)))?;
                self.text(name)?;
                bound.iter().try_for_each(|item| self.arg(item, table))
            }
        }
    }

    /// Write a value. A pattern gets a new handle in `table`, which the host
    /// owns from then on. A function does not cross in this direction.
    pub fn value(&mut self, value: &Value, table: &mut Table) -> Result<(), String> {
        self.put(value, table, 0, 0, 0)
    }

    fn put(
        &mut self,
        value: &Value,
        table: &mut Table,
        flags: u8,
        key: u32,
        depth: u32,
    ) -> Result<(), String> {
        if depth > MAX_DEPTH {
            return Err("value nests too deep for the tape".into());
        }
        let head = self.at;
        self.push(Cell::default())?;
        let (tag, payload) = match value {
            Value::Undefined => (UNDEFINED, [0; 8]),
            Value::Null => (NULL, [0; 8]),
            Value::Bool(flag) => (BOOL, words(u32::from(*flag), 0)),
            Value::F64(number) => (F64, number.to_le_bytes()),
            Value::Str(text) => (STR, words(self.atoms.intern(text), 0)),
            Value::List(items) => {
                for item in items {
                    self.put(item, table, 0, 0, depth + 1)?;
                }
                (LIST, words(items.len() as u32, 0))
            }
            Value::Object(members) => {
                for (name, member) in members.iter() {
                    let atom = self.atoms.intern(name);
                    self.put(member, table, KEYED, atom, depth + 1)?;
                }
                (OBJECT, words(members.len() as u32, 0))
            }
            Value::Pattern(inner) => (PATTERN, words(table.insert(inner.pattern().clone()), 0)),
            // A function with a callback id is the function of the host. A
            // native function has none, and the host sees its name.
            Value::Function(function) => match function.callback_id() {
                Some(id) => (FUNC, words(id as u32, 0)),
                None => (STR, words(self.atoms.intern(&format!("{function:?}")), 0)),
            },
            Value::Haps(haps) => {
                for hap in haps.as_slice() {
                    self.hap(hap, table)?;
                }
                (LIST, words(haps.as_slice().len() as u32, 0))
            }
            Value::JsValue(_) => {
                return Err("a host value is not supported by the binding".into());
            }
        };
        self.tape[head] = Cell {
            tag,
            flags,
            pad: 0,
            key,
            payload,
        };
        Ok(())
    }
}

/// Read a value as the engine type. A pattern becomes a `PatternValue`, a
/// function becomes a callback reference. Object keys keep their order.
pub fn to_value(arg: &Arg, identity: &mut u64) -> Value {
    match arg {
        Arg::Undefined => Value::Undefined,
        Arg::Null => Value::Null,
        Arg::Bool(flag) => Value::Bool(*flag),
        Arg::Num(number) => Value::F64(*number),
        Arg::Str(text) => Value::Str(text.clone()),
        Arg::List(items) => {
            Value::List(items.iter().map(|item| to_value(item, identity)).collect())
        }
        Arg::Object(members) => {
            let mut map = OrderedMap::new();
            for (name, member) in members {
                map.insert(name.clone(), to_value(member, identity));
            }
            Value::Object(map)
        }
        Arg::Pattern(pattern) => {
            *identity += 1;
            Value::Pattern(Box::new(PatternValue::new(
                *identity as usize,
                pattern.clone(),
            )))
        }
        Arg::Func(func) => Value::Function(rustel_core::value::FunctionRef::js(func.id as usize)),
        // A fraction in a value is its number, as a fraction which reaches a
        // registry name is. The exact value stays on the objects.
        Arg::Frac(fraction) => Value::F64(fraction.to_f64()),
        Arg::Span(span) => Value::object([
            ("begin".to_owned(), Value::F64(span.begin.to_f64())),
            ("end".to_owned(), Value::F64(span.end.to_f64())),
        ]),
        // A hap a function gives back is read as an object by the engine
        // (`arpWith` reads `value` and `context`). Its times are numbers here.
        Arg::Hap(hap) => Value::object([
            (
                "whole".to_owned(),
                hap.whole.map_or(Value::Undefined, |whole| {
                    to_value(&Arg::Span(whole), identity)
                }),
            ),
            ("part".to_owned(), to_value(&Arg::Span(hap.part), identity)),
            ("value".to_owned(), to_value(&hap.value, identity)),
            ("context".to_owned(), to_value(&hap.context, identity)),
            ("stateful".to_owned(), Value::Bool(false)),
        ]),
        Arg::State(state) => to_value(&state.controls, identity),
    }
}
