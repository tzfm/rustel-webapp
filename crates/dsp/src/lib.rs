//! The audio renderer as a wasm module with no imports.
//!
//! One thread calls every export: the audio render thread. The glue copies
//! bytes into the areas `dsp_init` hands out, then calls `dsp_render`. Nothing
//! allocates after `dsp_init`.
//!
//! ```text
//! glue, once per quantum                      this module
//! control words (9 x u32)  ----copy---->  layout.control   \
//! event records            ----copy---->  layout.inbox      > dsp_render
//! 256 floats               <---read-----  layout.output    /
//! counters                 <---read-----  layout.telemetry
//! ```

use std::cell::UnsafeCell;
use std::mem::{MaybeUninit, size_of};
use std::ptr;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};

use rustel_audio::tripwire::{self, TripwireAlloc, Violations};
use rustel_audio::{AudioEvent, LiveFlipAtomics, LiveScalarBackend, Ring};
use rustel_web_wire::{CONTROL_WORDS, canonical_event};

#[global_allocator]
static ALLOCATOR: TripwireAlloc = TripwireAlloc;

/// Frames per render call.
pub const QUANTUM: usize = 128;
/// Event records the glue stages for one render call, at most.
pub const INBOX_RECORDS: usize = 64;
/// `u32` words of the telemetry block.
pub const TELEMETRY_WORDS: usize = 8;

// Telemetry word indexes. Counts start at 0 in `dsp_init` and wrap at 2^32.

/// Events the engine accepted.
pub const ACCEPTED: usize = 0;
/// Events of a replaced generation, dropped.
pub const STALE: usize = 1;
/// Events the engine refused, for example with no free voice.
pub const REFUSED: usize = 2;
/// Accepted events with a target frame already in the past.
pub const LATE: usize = 3;
/// Records dropped because the local ring was full.
pub const RING_REFUSED: usize = 4;
/// Ring operations refused because a second thread tried to use the ring.
pub const ROLE_CONFLICTS: usize = 5;
/// Events dropped from the ring under stop.
pub const FLUSHED: usize = 6;
/// Low 32 bits of the generation the engine plays now. Not a count.
pub const GENERATION: usize = 7;

/// Slots of the ring between the inbox and the engine. An event past the 2 s
/// admission horizon waits here. The count equals the shared event ring.
const RING_RECORDS: usize = 512;

/// Where the glue finds every area of the module. On wasm32 each field is one
/// `u32` and the struct holds five.
#[repr(C)]
pub struct DspLayout {
    /// Bytes of one event record, the size of `AudioEvent`.
    pub record_bytes: usize,
    /// `INBOX_RECORDS` records. The glue writes, the module reads.
    pub inbox: *mut u8,
    /// `CONTROL_WORDS` words. The glue writes, the module reads.
    pub control: *mut u32,
    /// `QUANTUM * 2` interleaved stereo floats. The module writes.
    pub output: *const f32,
    /// `TELEMETRY_WORDS` words. The module writes.
    pub telemetry: *const u32,
}

struct Dsp {
    live: LiveScalarBackend,
    ring: Ring,
    generation: AtomicU64,
    takeover_frame: AtomicU64,
    takeover_cut: AtomicU64,
    line_arm: AtomicU64,
    stopped: AtomicBool,
    out: [f32; QUANTUM * 2],
    inbox: Box<[MaybeUninit<AudioEvent>]>,
    control: [u32; CONTROL_WORDS],
    telemetry: [u32; TELEMETRY_WORDS],
    layout: DspLayout,
    /// Allocator counts at the end of `dsp_init`.
    baseline: Violations,
}

struct Slot(UnsafeCell<Option<Box<Dsp>>>);

// SAFETY: the module has one thread. No export runs inside another.
unsafe impl Sync for Slot {}

static DSP: Slot = Slot(UnsafeCell::new(None));

fn dsp() -> Option<&'static mut Dsp> {
    // SAFETY: single thread, and each export takes this reference once.
    unsafe { (*DSP.0.get()).as_deref_mut() }
}

impl Dsp {
    fn control_value(&self, index: usize) -> u64 {
        u64::from(self.control[index]) | (u64::from(self.control[index + 1]) << 32)
    }

    /// Moves the control words into the atomics the engine reads. The order
    /// matches a native producer: takeover and cut first, generation last.
    fn adopt_control(&self) {
        self.takeover_frame
            .store(self.control_value(2), Ordering::Release);
        self.takeover_cut
            .store(self.control_value(4), Ordering::Release);
        self.line_arm
            .store(self.control_value(6), Ordering::Release);
        self.generation
            .store(self.control_value(0), Ordering::Release);
        self.stopped.store(self.control[8] != 0, Ordering::Release);
    }
}

/// Limits every sample to -1..1 and turns a NaN into 0.
fn sanitize(samples: &mut [f32]) {
    for sample in samples {
        *sample = if sample.is_nan() {
            0.0
        } else {
            sample.clamp(-1.0, 1.0)
        };
    }
}

fn count(word: &mut u32, by: usize) {
    *word = word.wrapping_add(by as u32);
}

/// Prepares the renderer and returns the layout of its areas. Allocates
/// everything the render path needs. Returns null when the engine refuses the
/// arguments (`voice_capacity` outside 1..=4096) or the allocation tripwire
/// does not count. A second call replaces the first state and its layout.
#[unsafe(no_mangle)]
pub extern "C" fn dsp_init(sample_rate: u32, voice_capacity: u32) -> *const DspLayout {
    let Ok(live) = LiveScalarBackend::new(sample_rate, voice_capacity as usize) else {
        return ptr::null();
    };
    let canonical = canonical_event();
    let ring = Ring::new(RING_RECORDS);
    // Claim both ring roles here. The first use of the thread handle
    // allocates, and the allocation must not happen inside a render call.
    ring.push(canonical);
    ring.pop();
    if !tripwire::allocator_is_armed() {
        return ptr::null();
    }
    let mut state = Box::new(Dsp {
        live,
        ring,
        generation: AtomicU64::new(0),
        takeover_frame: AtomicU64::new(0),
        takeover_cut: AtomicU64::new(0),
        line_arm: AtomicU64::new(0),
        stopped: AtomicBool::new(false),
        out: [0.0; QUANTUM * 2],
        inbox: Box::new_uninit_slice(INBOX_RECORDS),
        control: [0; CONTROL_WORDS],
        telemetry: [0; TELEMETRY_WORDS],
        layout: DspLayout {
            record_bytes: size_of::<AudioEvent>(),
            inbox: ptr::null_mut(),
            control: ptr::null_mut(),
            output: ptr::null(),
            telemetry: ptr::null(),
        },
        baseline: Violations::capture(),
    });
    // The areas live in the box, so their addresses stay fixed from here on.
    state.layout.inbox = state.inbox.as_mut_ptr().cast();
    state.layout.control = state.control.as_mut_ptr();
    state.layout.output = state.out.as_ptr();
    state.layout.telemetry = state.telemetry.as_ptr();
    let layout = &raw const state.layout;
    // SAFETY: single thread, and no reference into the slot is alive.
    unsafe { *DSP.0.get() = Some(state) };
    layout
}

/// Renders one quantum of interleaved stereo into `layout.output`.
///
/// `frame` is the absolute frame of the first sample. `records` is the number
/// of event records in `layout.inbox`. `layout.control` holds one whole
/// snapshot of the control words. When the glue misses a whole snapshot, the
/// glue leaves the previous words in place and passes 0 records: a record
/// judged against old words is dropped as stale.
///
/// Under stop the engine admits nothing and leaves the ring alone. The module
/// empties the ring, so no event sent under stop sounds later.
///
/// Returns the number of events the engine accepted in this call.
#[unsafe(no_mangle)]
pub extern "C" fn dsp_render(frame: f64, records: u32) -> u32 {
    let Some(dsp) = dsp() else { return 0 };
    tripwire::audio_scope(|| {
        dsp.adopt_control();
        for record in &dsp.inbox[..(records as usize).min(INBOX_RECORDS)] {
            // SAFETY: the glue copied the bytes of an `AudioEvent` from the
            // engine module. Both modules build the same source with the same
            // compiler, and the page compares their canonical events.
            let event = unsafe { record.assume_init_read() };
            if !dsp.ring.push(event) {
                count(&mut dsp.telemetry[RING_REFUSED], 1);
            }
        }
        let report = dsp.live.process_block_with(
            &mut dsp.out,
            QUANTUM,
            frame as u64,
            &dsp.ring,
            LiveFlipAtomics {
                generation: &dsp.generation,
                takeover_frame: &dsp.takeover_frame,
                takeover_cut: &dsp.takeover_cut,
                line_arm: &dsp.line_arm,
            },
            &dsp.stopped,
        );
        if dsp.stopped.load(Ordering::Acquire) {
            while dsp.ring.pop().is_some() {
                count(&mut dsp.telemetry[FLUSHED], 1);
            }
        }
        sanitize(&mut dsp.out);
        let telemetry = &mut dsp.telemetry;
        count(&mut telemetry[ACCEPTED], report.accepted);
        count(&mut telemetry[STALE], report.stale);
        count(&mut telemetry[REFUSED], report.refused);
        count(&mut telemetry[LATE], report.late);
        telemetry[ROLE_CONFLICTS] = dsp.ring.role_conflicts.load(Ordering::Relaxed) as u32;
        telemetry[GENERATION] = dsp.live.generation() as u32;
        report.accepted as u32
    })
}

/// Allocations inside render calls since `dsp_init`. The count is 0 in steady
/// state. Returns `u32::MAX` before `dsp_init`.
#[unsafe(no_mangle)]
pub extern "C" fn dsp_allocations() -> u32 {
    dsp().map_or(u32::MAX, |dsp| {
        Violations::capture().since(dsp.baseline).allocs as u32
    })
}

/// Compares record 0 of `layout.inbox` with this module's canonical event.
/// The glue copies the canonical event of the engine module there first.
/// Returns 1 when the two events are equal, and 0 when they differ or before
/// `dsp_init`.
#[unsafe(no_mangle)]
pub extern "C" fn dsp_canonical_matches() -> u32 {
    let Some(dsp) = dsp() else { return 0 };
    // SAFETY: the glue wrote record 0 with the bytes of the engine module's
    // canonical event. Both modules build the same source, and this check
    // exists to catch a build which does not. The comparison is by value,
    // since padding bytes are not defined.
    let event = unsafe { dsp.inbox[0].assume_init_read() };
    u32::from(event == canonical_event())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitize_limits_and_clears_nan() {
        let mut samples = [0.5, 3.0, -3.0, f32::NAN, f32::INFINITY, f32::NEG_INFINITY];
        sanitize(&mut samples);
        assert_eq!(samples, [0.5, 1.0, -1.0, 0.0, 1.0, -1.0]);
    }

    #[test]
    fn canonical_bytes_decode_to_the_canonical_event() {
        // SAFETY: the layout lives in the module state until the next init.
        let layout = unsafe { &*dsp_init(48_000, 8) };
        assert_eq!(layout.record_bytes, size_of::<AudioEvent>());
        // The glue copies the bytes of an event into record 0.
        let copy = |event: &AudioEvent| {
            let bytes = ptr::from_ref(event).cast::<u8>();
            // SAFETY: the inbox holds a record of `record_bytes` bytes.
            unsafe { ptr::copy_nonoverlapping(bytes, layout.inbox, layout.record_bytes) };
        };
        let mut event = canonical_event();
        copy(&event);
        assert_eq!(dsp_canonical_matches(), 1);
        event.cut = None;
        copy(&event);
        assert_eq!(dsp_canonical_matches(), 0);
    }
}
