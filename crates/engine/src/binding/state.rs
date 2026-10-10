//! The state of the module: one tape, one atom table, one pattern table.
//!
//! Each piece sits in its own cell so a borrow never spans a call to the
//! host. A callback re-enters the exports, and a borrow held across the
//! import would panic there.

use crate::binding::table::Table;
use crate::binding::tape::{Atoms, Cell};
use rustel_core::Pattern;
use std::cell::{Cell as Slot, RefCell};

/// Tape size in cells: 1 MiB. A larger value fails its call.
pub const TAPE_CELLS: usize = 65_536;

thread_local! {
    pub static TAPE: RefCell<Vec<Cell>> = RefCell::new(vec![Cell::default(); TAPE_CELLS]);
    pub static ATOMS: RefCell<Atoms> = RefCell::new(Atoms::default());
    pub static TABLE: RefCell<Table> = RefCell::new(Table::default());
    /// Text in transit: a new atom in either direction, an error, hap lines.
    pub static SCRATCH: RefCell<Vec<u8>> = const { RefCell::new(Vec::new()) };
    /// Why the last failed call failed.
    pub static LAST_ERROR: RefCell<String> = const { RefCell::new(String::new()) };
    /// How many callbacks are live on the stack of the host.
    pub static DEPTH: Slot<u32> = const { Slot::new(0) };
}

/// A clone of a pattern of the table.
pub fn pattern(handle: u32) -> Option<Pattern> {
    TABLE.with_borrow(|table| table.get(handle))
}

/// Keep a pattern and return its handle.
pub fn keep(pattern: Pattern) -> u32 {
    TABLE.with_borrow_mut(|table| table.insert(pattern))
}

/// Copy text into the scratch buffer. Returns its byte length.
pub fn fill_scratch(text: &[u8]) -> u32 {
    SCRATCH.with_borrow_mut(|scratch| {
        scratch.clear();
        scratch.extend_from_slice(text);
        text.len() as u32
    })
}

/// Keep the message of a failed call for `bind_last_error`.
pub fn fail(message: String) -> u32 {
    LAST_ERROR.with_borrow_mut(|last| *last = message);
    u32::MAX
}
