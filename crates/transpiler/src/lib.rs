//! The score transpiler of the engine as a wasm module with no imports.
//!
//! One thread calls every export: the Worker. The glue copies the score text
//! into the scratch buffer, calls `tp_transpile`, and copies the result text
//! out. Wasm has no thread to spawn, so every parse runs inside
//! `on_caller_stack`, on the stack of the module. The stack size is a link
//! setting of `scripts/wasm-build`.
//!
//! ```text
//! glue                                         this module
//! score text (UTF-8)      ----copy---->  tp_scratch   --> tp_transpile
//! result text (JSON)      <---copy-----  tp_result    <-/
//! printed line and column ----pass---->  tp_original_position
//! score line and column   <---return---/
//! ```
//!
//! A source which defeats the nesting scan of the engine overflows the stack
//! and traps. A trap is a refusal. The glue drops the instance and makes a new
//! one, because a trap leaves the state of the module half written. A panic is
//! a trap too.

pub mod wire;

use std::cell::RefCell;

use rustel_transpiler::LineMap;

/// What `tp_transpile` returns when the bytes are no score text.
pub const FAILED: u32 = u32::MAX;
/// What `tp_original_position` returns when the line map has no answer.
pub const NO_POSITION: u64 = u64::MAX;

thread_local! {
    /// The score text in transit.
    static SCRATCH: RefCell<Vec<u8>> = const { RefCell::new(Vec::new()) };
    /// The result of the last transpile.
    static RESULT: RefCell<String> = const { RefCell::new(String::new()) };
    /// The line map of the last transpile. The engine keeps its tokens
    /// private, so the glue asks for one position at a time.
    static LINE_MAP: RefCell<Option<LineMap>> = const { RefCell::new(None) };
}

/// Returns a buffer of at least `bytes` bytes for the score text. The glue
/// writes the text there before each `tp_transpile`. The buffer grows and
/// never shrinks, so the glue asks again before each write. A request which
/// the memory cannot hold traps.
///
/// The pointer is never null and stays valid until the next call of an export.
/// The memory grows during a call, so the glue builds a new view of the memory
/// after each call.
#[unsafe(no_mangle)]
pub extern "C" fn tp_scratch(bytes: u32) -> *mut u8 {
    SCRATCH.with_borrow_mut(|scratch| {
        if scratch.len() < bytes as usize {
            scratch.resize(bytes as usize, 0);
        }
        scratch.as_mut_ptr()
    })
}

/// Transpiles the first `bytes` bytes of the scratch buffer as a score and
/// stores the result for `tp_result`. Returns the byte length of the result
/// text. A source which the engine refuses is no failure: the result holds the
/// diagnostics.
///
/// Returns `FAILED` when the bytes are not UTF-8, or when `bytes` is more than
/// the scratch buffer holds. The result is then empty and the line map has no
/// answer.
///
/// The result is one JSON object. Offsets are UTF-8 byte offsets in the score
/// text.
///
/// ```text
/// output          the text every position below refers to
/// body            the text for the script engine to run: output with a final return
/// awaits          true when the output holds an `await`
/// mini_locations  [from, to] of each atom of each mini-notation string
/// diagnostics     { message, offset or null }, empty when the score runs
///                 (a refused score has an empty body)
/// widgets         one record for each slider and visual painter
/// registrations   { names, has_dynamic_names, final_expression_is_registration }
/// ```
#[unsafe(no_mangle)]
pub extern "C" fn tp_transpile(bytes: u32) -> u32 {
    let text = SCRATCH.with_borrow(|scratch| {
        let bytes = scratch.get(..bytes as usize)?;
        std::str::from_utf8(bytes).ok().map(str::to_owned)
    });
    let Some(text) = text else {
        RESULT.with_borrow_mut(String::clear);
        LINE_MAP.with_borrow_mut(|map| *map = None);
        return FAILED;
    };
    let run = rustel_transpiler::on_caller_stack(|| wire::run(&text));
    let json = wire::encode(&run);
    LINE_MAP.with_borrow_mut(|map| *map = Some(run.output.line_map));
    RESULT.with_borrow_mut(|result| {
        *result = json;
        result.len() as u32
    })
}

/// Returns the result text of the last `tp_transpile`. The glue reads as many
/// bytes as the call returned. The pointer is never null, and the text is empty
/// before the first call. The pointer stays valid until the next call of an
/// export.
#[unsafe(no_mangle)]
pub extern "C" fn tp_result() -> *const u8 {
    RESULT.with_borrow(|result| result.as_ptr())
}

/// Returns the score position of a printed position of the last result. The
/// glue maps an error position of the output text back to the score text.
/// Both positions are zero based. The printed line counts the lines of
/// `output`, split at `\n`. Both columns count UTF-16 code units, as the source
/// map format does.
///
/// The score line is in the high 32 bits and the score column in the low 32
/// bits. Returns `NO_POSITION` when the map has no answer, also before the
/// first call and after a `FAILED` call.
#[unsafe(no_mangle)]
pub extern "C" fn tp_original_position(line: u32, column: u32) -> u64 {
    LINE_MAP.with_borrow(|map| {
        map.as_ref()
            .and_then(|map| map.original_position(line, column))
            .map_or(NO_POSITION, |(line, column)| {
                (u64::from(line) << 32) | u64::from(column)
            })
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn transpile(bytes: &[u8]) -> u32 {
        let scratch = tp_scratch(bytes.len() as u32);
        // SAFETY: the scratch buffer holds `bytes.len()` bytes.
        unsafe { std::ptr::copy_nonoverlapping(bytes.as_ptr(), scratch, bytes.len()) };
        tp_transpile(bytes.len() as u32)
    }

    #[test]
    fn bytes_which_are_no_text_fail_and_clear_the_last_result() {
        assert_ne!(transpile(b"f(a)"), FAILED);
        assert_ne!(tp_original_position(0, 0), NO_POSITION);

        assert_eq!(transpile(&[0xff, 0xfe]), FAILED);
        assert!(RESULT.with_borrow(String::is_empty));
        assert_eq!(tp_original_position(0, 0), NO_POSITION);

        let held = SCRATCH.with_borrow(Vec::len) as u32;
        assert_eq!(tp_transpile(held + 1), FAILED);
    }
}
