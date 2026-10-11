//! The pattern engine as a wasm module with one import, `host_call`.
//!
//! One thread calls every export: the Worker. Time arrives as the audio frame
//! of each call, so the module reads no clock. The glue copies text into the
//! areas `engine_init` hands out, calls the exports, and copies the records
//! and the control words out.
//!
//! A pattern comes from mini-notation text (`engine_set_pattern`) or from a
//! score (`engine_set_score`). The score side is the `binding` module: a score
//! runs in the host, builds its patterns through the `bind_*` exports, and
//! hands the handle of the result to `engine_set_score`. The import carries a
//! score function back to the host while a query runs.
//!
//! ```text
//! glue                                        this module
//! pattern text             ----copy---->  layout.text     --> engine_set_pattern
//! free slots of the ring   ----pass---->                  --> engine_turn
//! event records            <---copy-----  layout.records  <-/
//! control words (8 x u32)  <---copy-----  layout.control
//! ```
//!
//! A turn queries the pattern 2 s ahead of the frame and resolves each event
//! to the bytes of an `AudioEvent`. Records the ring has no room for wait in
//! the module.
//!
//! A second engine instance continues the music of the first instance. The glue
//! of the first instance publishes the position after each turn
//! (`engine_position`). When the first instance is gone, the glue of the second
//! instance copies the position into its own area and calls `engine_adopt`.

pub mod binding;
mod frames;

use std::cell::{Cell, UnsafeCell};
use std::collections::VecDeque;
use std::mem::{MaybeUninit, size_of};
use std::ptr;
use std::sync::Arc;

use rustel_audio::AudioEvent;
use rustel_core::controls::{ControlSpec, default_control_registry};
use rustel_core::{Pattern, Value, pure, silence};
use rustel_scheduler::{Event, Scheduler, Transport, VirtualClock};
use rustel_voice::{BundledOnly, VoiceError, resolve_hap_value};
use rustel_web_wire::{CONTROL_WORDS, canonical_event};

use frames::onset_frame_edge;

/// Bytes of the text buffer.
pub const TEXT_CAPACITY: usize = 64 * 1024;
/// Bytes of the error buffer. A longer message is cut on a character boundary.
pub const ERROR_CAPACITY: usize = 512;
/// Records of the record buffer, so the most one turn writes.
pub const RECORD_CAPACITY: usize = 256;
/// Control words the module publishes. The stop flag belongs to the page.
pub const PUBLISHED_WORDS: usize = CONTROL_WORDS - 1;
/// Words of the position block: the generation, the covered frame, the anchor
/// second, the anchor cycle and the tempo as two words each, then the playing
/// flag, the events held, and the frame of the last turn, as one word each. A
/// 64-bit value takes its low word first, and the frame of the last turn keeps
/// its low 32 bits.
pub const POSITION_WORDS: usize = 13;
/// Frames from a call to its effect: 3 quanta. The takeover of an update, of a
/// tempo change and of an adopted position lands here. Old events cover the
/// gap, so the lead is the delay from an edit to its sound, and the lead stays
/// short.
pub const LEAD_FRAMES: u64 = 384;
/// Frames from a play to its first onset: 7 quanta, 18.7 ms at 48 kHz. Nothing
/// sounds before a play, so a longer lead costs only a later first sound, and
/// the record gets time to cross the ring.
///
/// Headless Firefox calls the renderer for 4 quanta in a row (512 frames) once
/// every 10.67 ms. The Worker reads the audio frame between two groups, so the next
/// group starts on the frame read, and the record must reach the ring before
/// this group ends. Else the group after takes the record, 512 frames past the
/// frame read. A lead of `LEAD_FRAMES` is 128 frames short of this second group,
/// and a busy Worker misses the first group now and then.
///
/// In the `scores` session of the browser test, 4 of 90 runs had a late event
/// at 384 frames, and 0 of 30 runs at each of 768, 1152 and 1536. A probe in the
/// renderer saw 3 late events, all on the first onset of a play and all 128
/// frames late. The value is the smallest lead with no late run, 768, plus one
/// quantum. At 896 frames the second group takes the record on time too: 0 late
/// runs of 30 in the `scores` session and in the `recovery` session. The first
/// sound comes 10.67 ms later than with `LEAD_FRAMES`.
pub const PLAY_LEAD_FRAMES: u64 = 896;
/// What a failed export returns.
pub const FAILED: i32 = -1;

/// Seconds of schedule kept ahead of the frame. The events in the ring cover
/// the 1 s the glue needs to see a hang, the promotion of the standby, and a
/// margin.
const HORIZON_SECS: f64 = 2.0;
/// Events the engine lets the renderer hold at once. The renderer keeps the
/// events which wait for their onset and the events which sound in one pool of
/// 64, and refuses an event when the pool is full. A horizon of 2 s puts four
/// times the events of a horizon of 0.5 s in the pool. Over 12 s with the real
/// modules, the horizon of 2 s with no budget refused 12 events at 32 events a
/// second, 447 at 64 and 893 at 96, where the horizon of 0.5 s refused none.
///
/// The engine sends an event only while the events the engine sent, and the
/// renderer still holds, stay within this budget. An event past the budget waits in the
/// module, in onset order. A sparse score is covered `HORIZON_SECS` ahead, and
/// a dense score is covered by the budget: 60 events ahead.
///
/// An event counts from the send to the end of its sound. Counted to the onset
/// only, the budget lost events of scores with overlapping notes which the
/// horizon of 0.5 s kept: 36 in 12 s at 24 events a second of notes 1 s long.
/// Counted as written, a budget up to 64 refuses no event at 30 to 256 events a
/// second, and 65 refuses 8 to 45 events. A score with samples and notes refused
/// 12 events at 64, since the engine does not see the end of every voice. The
/// budget keeps 4 below the limit.
pub const SEND_BUDGET: usize = 60;
/// Seconds a sample voice sounds, at least. A sample voice plays its slice and
/// not the hap, and the engine does not know the length of the slice. With less
/// than 0.25 s the renderer refused events of `bd` at 32 to 128 events a second
/// which the horizon of 0.5 s kept.
const SAMPLE_VOICE_SECS: f64 = 0.3;
/// Seconds the first turn after a start or a takeover reaches ahead, and the
/// seconds the reach grows on each turn after. A first turn which queried the
/// whole horizon does up to four times the work, and the work grows with the
/// density of the score. In Node, the first turn of `c3*256` takes 1.1 ms with
/// the ramp and 4.2 ms without, and the first turn of `c3*1024` takes 4.2 ms
/// and 16.7 ms. The records of the turn must reach the ring inside the lead:
/// `PLAY_LEAD_FRAMES` after a play, `LEAD_FRAMES` after an update. In the
/// browser test, the renderer took the first record after the frame read in 2
/// of 150 plays with the ramp and in 6 of 150 without. The reach is whole on the
/// fourth turn, 30 ms after the first.
const FIRST_REACH_SECS: f64 = 0.5;
const REACH_STEP_SECS: f64 = 0.5;
/// Cycles per second until `engine_set_cps`.
const DEFAULT_CPS: f64 = 0.5;
/// The sounds of control 0, indexed by the waveform argument.
const WAVEFORMS: [&str; 4] = ["sine", "sawtooth", "square", "triangle"];

/// Where the glue finds every area of the module. On wasm32 each field is one
/// `u32` and the struct holds ten.
#[repr(C)]
pub struct EngineLayout {
    /// UTF-8 pattern text. The glue writes, `engine_set_pattern` reads.
    pub text: *mut u8,
    /// Bytes of `text`, at least 64 KiB.
    pub text_capacity: usize,
    /// UTF-8 message of the last failed `engine_set_pattern` or
    /// `engine_set_score`. The module writes.
    pub error: *const u8,
    /// Bytes of the message in `error`. 0 after a call which succeeds.
    pub error_len: Cell<u32>,
    /// `record_capacity` event records. The module writes, the glue reads the
    /// first `engine_turn` returns.
    pub records: *const u8,
    /// Bytes of one record, the size of `AudioEvent`.
    pub record_bytes: usize,
    /// Records of `records`.
    pub record_capacity: usize,
    /// `PUBLISHED_WORDS` words, laid out as the first words of the wire
    /// control block. `engine_turn` refreshes them. The module writes.
    pub control: *const u32,
    /// Events the voice resolver refused, which the module skipped. Counts
    /// from `engine_init` and wraps at 2^32.
    pub refused: Cell<u32>,
    /// `POSITION_WORDS` words. `engine_position` writes them. The glue of a
    /// standby writes them before `engine_adopt`, which reads them.
    pub position: *mut u32,
}

struct Engine {
    sample_rate: u32,
    scheduler: Scheduler,
    clock: VirtualClock,
    /// The pattern of the last accepted text. Silence before the first.
    pattern: Pattern,
    /// Cycles per second of the next generation.
    cps: f64,
    /// A point of the mapping from cycles to seconds: a second and its cycle.
    anchor: (f64, f64),
    playing: bool,
    /// The generation of the scheduler.
    generation: u64,
    /// The generation the records and the control words carry, minus
    /// `generation`. An engine which adopts a position continues the count of
    /// the engine before.
    generation_base: u64,
    takeover_frame: u64,
    /// The first frame whose events are not all in the ring: the queries reach
    /// this frame.
    covered: u64,
    /// Seconds the next turn queries ahead of the frame, at most `HORIZON_SECS`.
    reach: f64,
    /// Resolved events the record buffer has no room for yet, by onset.
    pending: VecDeque<AudioEvent>,
    /// The onset frame and the frame the sound ends, of each event written to
    /// the ring whose sound has not ended: the pool of the renderer. After an
    /// adopted position, the pool of the engine before stands in for the events
    /// of the engine before.
    held: Vec<(u64, u64)>,
    /// The frame of the last turn.
    turned: u64,
    text: Box<[u8]>,
    error: Box<[u8]>,
    records: Box<[MaybeUninit<AudioEvent>]>,
    control: [u32; PUBLISHED_WORDS],
    position: [u32; POSITION_WORDS],
    canonical: AudioEvent,
    layout: EngineLayout,
}

struct Slot(UnsafeCell<Option<Box<Engine>>>);

// SAFETY: the module has one thread. No export runs inside another.
unsafe impl Sync for Slot {}

static ENGINE: Slot = Slot(UnsafeCell::new(None));

fn engine() -> Option<&'static mut Engine> {
    // SAFETY: single thread, and each export takes this reference once.
    unsafe { (*ENGINE.0.get()).as_deref_mut() }
}

/// A frame from the glue as a whole frame. A negative or NaN frame reads as 0.
fn whole_frame(frame: f64) -> u64 {
    frame as u64
}

/// A control the pinned table names.
fn control(name: &str) -> &'static ControlSpec {
    default_control_registry()
        .get(name)
        .expect("the pinned control table has every control the engine uses")
}

/// The record of one scheduled event, or the reason the voice resolver
/// refused the event. The fields follow `live_audio_event` in the engine
/// repository, file `crates/runtime/src/render.rs`.
fn audio_event(
    event: &Event,
    sample_rate: u32,
    cps: f64,
    generation_base: u64,
) -> Result<AudioEvent, VoiceError> {
    let onset = resolve_hap_value(
        &event.value,
        event.onset_id,
        event.duration.to_f64() / cps,
        event.target_time,
        sample_rate,
        cps,
        &BundledOnly,
    )?;
    Ok(AudioEvent {
        onset_id: event.onset_id,
        generation: event.generation.wrapping_add(generation_base),
        ui_visuals: event.ui_visuals,
        target_frame: onset.onset_frame,
        onset_lead: onset.onset_lead,
        freq_hz: onset.freq_hz,
        gain: onset.gain,
        duration_secs: onset.duration_secs,
        controls: onset.controls,
        sample: onset.sample,
        wavetable: onset.wavetable,
        synth: onset.synth,
        cut: None,
    })
}

/// The frame at which the renderer lets go of the event: the end of the note and
/// its release. A sample voice sounds at least `SAMPLE_VOICE_SECS`.
fn voice_end(event: &AudioEvent, sample_rate: u32) -> u64 {
    let mut secs = f64::from(event.duration_secs) + f64::from(event.controls.envelope.release_secs);
    if event.sample.is_some() {
        secs = secs.max(SAMPLE_VOICE_SECS);
    }
    let frames = (secs * f64::from(sample_rate)).ceil() as u64;
    event.target_frame.saturating_add(frames)
}

impl Engine {
    /// The pattern the text names: notes with a waveform for control 0, sound
    /// names for control 1.
    fn parse(&self, text_len: usize, control_id: u32, waveform: u32) -> Result<Pattern, String> {
        let bytes = self
            .text
            .get(..text_len)
            .ok_or_else(|| format!("the text is longer than {TEXT_CAPACITY} bytes"))?;
        let text = std::str::from_utf8(bytes).map_err(|_| "the text is not UTF-8".to_owned())?;
        let steps = rustel_mini::mini(text).map_err(|error| error.to_string())?;
        match control_id {
            0 => {
                let sound = WAVEFORMS
                    .get(waveform as usize)
                    .ok_or_else(|| format!("waveform {waveform} is not 0 to 3"))?;
                let notes = control("note").standalone(&steps);
                Ok(control("s").apply(&notes, Some(pure(Value::Str((*sound).into())))))
            }
            1 => Ok(control("s").standalone(&steps)),
            _ => Err(format!("control {control_id} is not 0 or 1")),
        }
    }

    /// Makes the pattern the playing pattern. While playing, the pattern takes
    /// over `LEAD_FRAMES` after `frame`. Returns the generation the engine is on.
    fn adopt(&mut self, pattern: Pattern, frame: f64) -> i32 {
        self.layout.error_len.set(0);
        self.pattern = pattern;
        if self.playing {
            self.take_over(whole_frame(frame));
        }
        i32::try_from(self.engine_generation()).unwrap_or(i32::MAX)
    }

    /// The generation the records and the control words carry.
    fn engine_generation(&self) -> u64 {
        self.generation.wrapping_add(self.generation_base)
    }

    /// Writes the message into the error buffer and returns the failure code.
    fn fail(&mut self, message: &str) -> i32 {
        let mut len = message.len().min(ERROR_CAPACITY);
        while !message.is_char_boundary(len) {
            len -= 1;
        }
        self.error[..len].copy_from_slice(&message.as_bytes()[..len]);
        self.layout.error_len.set(len as u32);
        FAILED
    }

    /// Starts the pattern at cycle 0, with the first onset `PLAY_LEAD_FRAMES`
    /// after `frame`. Takeover frame 0 makes the generation a new lifetime: the
    /// device and the record buffer keep nothing from before.
    fn start(&mut self, frame: u64) {
        let first_onset =
            frame.saturating_add(PLAY_LEAD_FRAMES) as f64 / f64::from(self.sample_rate);
        self.generation =
            self.scheduler
                .replace_pattern(self.pattern.clone(), first_onset, Some(self.cps));
        self.scheduler.rebase_start_anchor(first_onset);
        self.anchor = (first_onset, 0.0);
        self.takeover_frame = 0;
        self.covered = 0;
        self.held.clear();
        self.reach = FIRST_REACH_SECS;
        self.playing = true;
    }

    /// Replaces the generation on the takeover frame, `LEAD_FRAMES` after
    /// `frame`. The device keeps the events of the old generation before the
    /// takeover frame and drops the rest. The new generation queries from the
    /// first instant on the takeover frame, so no onset sounds twice or not at
    /// all.
    ///
    /// The mapping from cycles to seconds stays whole. A replace alone
    /// re-anchors the mapping on a rounded cycle, which moves each onset of
    /// the new generation by a fraction of a frame against its old copy, and
    /// an onset on the frame before the takeover sounds twice. A new tempo
    /// pivots the mapping on the takeover, at the cycle the old tempo has
    /// there, so the phase carries over.
    fn take_over(&mut self, frame: u64) {
        let takeover = frame.saturating_add(LEAD_FRAMES);
        let edge = onset_frame_edge(takeover, self.sample_rate);
        if self.cps != self.scheduler.cps() {
            self.anchor = (edge, self.scheduler.cycle_at_time(edge));
        }
        self.cut_over(takeover, edge);
    }

    /// Replaces the generation on the `takeover` frame, with the mapping in
    /// `anchor` and the tempo in `cps`. `edge` is the first instant on the
    /// takeover frame.
    fn cut_over(&mut self, takeover: u64, edge: f64) {
        self.generation =
            self.scheduler
                .replace_pattern(self.pattern.clone(), edge, Some(self.cps));
        let (second, cycle) = self.anchor;
        self.scheduler.rebase_anchor_from(second, cycle, edge);
        self.takeover_frame = takeover;
        self.held.retain(|(onset, _)| *onset < takeover);
        self.reach = FIRST_REACH_SECS;
    }

    /// Seconds up to which the scheduler has queried the pattern.
    fn queried_secs(&self) -> f64 {
        self.anchor.0 + (self.scheduler.scheduled_to_cycle() - self.anchor.1) / self.cps
    }

    /// Continues the music of the position in `position`. The takeover frame
    /// is the first frame the other engine did not cover. An old position,
    /// which covers less than `LEAD_FRAMES` past `frame`, takes over at
    /// `LEAD_FRAMES` past `frame`, and the frames between are silent. An engine
    /// which does not play takes the tempo and the count of generations only.
    fn adopt_position(&mut self, frame: u64) -> i32 {
        let word =
            |at: usize| u64::from(self.position[at]) | (u64::from(self.position[at + 1]) << 32);
        let float = |at: usize| f64::from_bits(word(at));
        let (generation, covered) = (word(0), word(2));
        let (second, cycle, cps) = (float(4), float(6), float(8));
        let (held, turned) = (u64::from(self.position[11]), self.position[12]);
        if !(second.is_finite() && cycle.is_finite() && cps.is_finite() && cps > 0.0) {
            return self.fail("the position holds no anchor or tempo");
        }
        self.layout.error_len.set(0);
        self.cps = cps;
        self.anchor = (second, cycle);
        self.pending.clear();
        self.covered = 0;
        self.playing = self.position[10] != 0;
        if self.playing {
            let takeover = covered.max(frame.saturating_add(LEAD_FRAMES));
            let edge = onset_frame_edge(takeover, self.sample_rate);
            // Like `start`: the lifetime begins at cycle 0, and no cycle below 0 is queried.
            self.scheduler.rebase_start_anchor(edge);
            self.cut_over(takeover, edge);
            self.covered = takeover;
            self.seed_held(frame, covered, held, turned);
            self.generation_base = generation.wrapping_add(1).wrapping_sub(self.generation);
        } else {
            self.takeover_frame = 0;
            self.generation_base = generation.wrapping_sub(self.generation);
        }
        i32::try_from(self.engine_generation()).unwrap_or(i32::MAX)
    }

    /// Queries the horizon and resolves what falls due inside the horizon.
    fn fill(&mut self, frame: u64) {
        let now = frame as f64 / f64::from(self.sample_rate);
        self.clock.set(now);
        let through = now + self.reach;
        self.scheduler.set_horizon(self.reach);
        self.reach = (self.reach + REACH_STEP_SECS).min(HORIZON_SECS);
        // A pattern of a score calls its score functions while the scheduler
        // queries, so the callback host stays installed for the whole query.
        let events = rustel_core::with_callback_host(&binding::host::HOST, || {
            self.scheduler.tick(&self.clock);
            self.scheduler.drain_through(&self.clock, through)
        });
        // Each event before this frame is queried and drained into `pending`. The
        // frames before the takeover belong to the generation before, which the
        // ring holds.
        let reach = self.queried_secs().min(through);
        let queried = (reach * f64::from(self.sample_rate)).floor() as u64;
        self.covered = queried.max(self.takeover_frame);
        for event in events {
            match audio_event(&event, self.sample_rate, self.cps, self.generation_base) {
                Ok(record) => self.pending.push_back(record),
                Err(_) => self
                    .layout
                    .refused
                    .set(self.layout.refused.get().wrapping_add(1)),
            }
        }
    }

    /// Moves up to `free` pending events into the record buffer, while the pool
    /// of the renderer stays within `SEND_BUDGET`. Events of an older generation
    /// from the takeover frame on stay behind for good: the device drops them,
    /// and the new generation plays their onsets.
    fn write_records(&mut self, free: usize, frame: u64) -> usize {
        let (generation, takeover) = (self.engine_generation(), self.takeover_frame);
        self.pending
            .retain(|event| event.generation == generation || event.target_frame < takeover);
        self.held.retain(|(_, end)| *end > frame);
        self.turned = frame;
        let room = SEND_BUDGET.saturating_sub(self.held.len());
        let count = free.min(RECORD_CAPACITY).min(room).min(self.pending.len());
        for (slot, event) in self.records.iter_mut().zip(self.pending.drain(..count)) {
            self.held
                .push((event.target_frame, voice_end(&event, self.sample_rate)));
            slot.write(event);
        }
        count
    }

    fn publish(&mut self) {
        let low = |value: u64| value as u32;
        let high = |value: u64| (value >> 32) as u32;
        let generation = self.engine_generation();
        self.control = [
            low(generation),
            high(generation),
            low(self.takeover_frame),
            high(self.takeover_frame),
            // The takeover cut and the line arm stay at none.
            0,
            0,
            0,
            0,
        ];
    }

    /// Writes the position block from the state of the last turn.
    fn refresh_position(&mut self) {
        let covered = if self.playing {
            // An event which waits for room is not in the ring yet.
            self.pending
                .front()
                .map_or(self.covered, |event| event.target_frame.min(self.covered))
        } else {
            0
        };
        let low = |value: u64| value as u32;
        let high = |value: u64| (value >> 32) as u32;
        let generation = self.engine_generation();
        let (second, cycle, cps) = (
            self.anchor.0.to_bits(),
            self.anchor.1.to_bits(),
            self.cps.to_bits(),
        );
        self.position = [
            low(generation),
            high(generation),
            low(covered),
            high(covered),
            low(second),
            high(second),
            low(cycle),
            high(cycle),
            low(cps),
            high(cps),
            u32::from(self.playing),
            self.held.len() as u32,
            self.turned as u32,
        ];
    }

    /// The events of the engine before, which the renderer still holds, count in
    /// the pool. The position says how many the engine before held at its last
    /// turn, `turned`, and the events sound one after the other until `covered`.
    /// The engine takes the share left at `frame`, spread evenly over the frames
    /// to `covered`. The new events then wait only as long as the pool needs. A
    /// score of long overlapping notes sounds past `covered`, and the share
    /// counts too few events for such a score.
    fn seed_held(&mut self, frame: u64, covered: u64, held: u64, turned: u32) {
        let last = frame.saturating_sub(u64::from((frame as u32).wrapping_sub(turned)));
        let span = covered.saturating_sub(last).max(1);
        let left = covered.saturating_sub(frame);
        let count = (held * left).div_ceil(span).min(held);
        self.held = (1..=count)
            .map(|index| (0, frame + left * index / count))
            .collect();
    }
}

/// Prepares the engine and returns the layout of its areas. Allocates the
/// areas, and starts stopped with silence as the pattern at 0.5 cycles per
/// second. Returns null for a sample rate of 0. A second call replaces the
/// first state and its layout.
#[unsafe(no_mangle)]
pub extern "C" fn engine_init(sample_rate: u32) -> *const EngineLayout {
    if sample_rate == 0 {
        return ptr::null();
    }
    let mut state = Box::new(Engine {
        sample_rate,
        scheduler: Scheduler::new(Arc::new(Transport::default()), DEFAULT_CPS, HORIZON_SECS),
        clock: VirtualClock::new(0.0),
        pattern: silence(),
        cps: DEFAULT_CPS,
        anchor: (0.0, 0.0),
        playing: false,
        generation: 0,
        generation_base: 0,
        takeover_frame: 0,
        covered: 0,
        reach: FIRST_REACH_SECS,
        pending: VecDeque::new(),
        held: Vec::new(),
        turned: 0,
        text: vec![0; TEXT_CAPACITY].into_boxed_slice(),
        error: vec![0; ERROR_CAPACITY].into_boxed_slice(),
        records: Box::new_uninit_slice(RECORD_CAPACITY),
        control: [0; PUBLISHED_WORDS],
        position: [0; POSITION_WORDS],
        canonical: canonical_event(),
        layout: EngineLayout {
            text: ptr::null_mut(),
            text_capacity: TEXT_CAPACITY,
            error: ptr::null(),
            error_len: Cell::new(0),
            records: ptr::null(),
            record_bytes: size_of::<AudioEvent>(),
            record_capacity: RECORD_CAPACITY,
            control: ptr::null(),
            refused: Cell::new(0),
            position: ptr::null_mut(),
        },
    });
    // The areas live in the box, so their addresses stay fixed from here on.
    state.layout.text = state.text.as_mut_ptr();
    state.layout.error = state.error.as_mut_ptr().cast_const();
    state.layout.records = state.records.as_mut_ptr().cast_const().cast();
    state.layout.control = state.control.as_mut_ptr().cast_const();
    state.layout.position = state.position.as_mut_ptr();
    let layout = &raw const state.layout;
    // SAFETY: single thread, and no reference into the slot is alive.
    unsafe { *ENGINE.0.get() = Some(state) };
    layout
}

/// Builds the pattern from the first `text_len` bytes of `layout.text`.
///
/// `control` 0 plays the text as notes with the sound of `waveform`: 0 to 3
/// for sine, sawtooth, square and triangle. `control` 1 plays the text as
/// sound names, and `waveform` stays unused. While playing, the new pattern
/// takes over `LEAD_FRAMES` after `frame`. While stopped, the pattern waits for
/// the next play.
///
/// Returns the generation the engine is on, 0 or more. A failure returns
/// `FAILED` with the message in `layout.error`, and the pattern in use plays
/// on.
#[unsafe(no_mangle)]
pub extern "C" fn engine_set_pattern(
    text_len: u32,
    control: u32,
    waveform: u32,
    frame: f64,
) -> i32 {
    let Some(engine) = engine() else {
        return FAILED;
    };
    match engine.parse(text_len as usize, control, waveform) {
        Ok(pattern) => engine.adopt(pattern, frame),
        Err(message) => engine.fail(&message),
    }
}

/// Makes the pattern behind a binding handle the playing pattern. The
/// takeover rules are those of `engine_set_pattern`.
///
/// Returns the generation the engine is on, 0 or more. A handle which names
/// no live pattern returns `FAILED` with the message in `layout.error`, and
/// the pattern in use plays on. The engine keeps its own reference, so
/// freeing the handle afterwards is safe.
#[unsafe(no_mangle)]
pub extern "C" fn engine_set_score(handle: u32, frame: f64) -> i32 {
    let Some(engine) = engine() else {
        return FAILED;
    };
    match binding::state::pattern(handle) {
        Some(pattern) => engine.adopt(pattern, frame),
        None => engine.fail("the handle names no live pattern"),
    }
}

/// Sets the tempo. While playing, the new tempo takes over `LEAD_FRAMES` after
/// `frame`. While stopped, the tempo waits for the next play. A tempo which is
/// not finite and above 0 changes nothing.
#[unsafe(no_mangle)]
pub extern "C" fn engine_set_cps(cps: f64, frame: f64) {
    let Some(engine) = engine() else { return };
    if !cps.is_finite() || cps <= 0.0 {
        return;
    }
    engine.cps = cps;
    if engine.playing {
        engine.take_over(whole_frame(frame));
    }
}

/// Starts the pattern at cycle 0. The first onset lands `PLAY_LEAD_FRAMES`
/// after `frame`. A play while playing starts again.
#[unsafe(no_mangle)]
pub extern "C" fn engine_play(frame: f64) {
    if let Some(engine) = engine() {
        engine.start(whole_frame(frame));
    }
}

/// Stops the records. Events not yet written are dropped. The next play
/// starts at cycle 0.
#[unsafe(no_mangle)]
pub extern "C" fn engine_stop() {
    if let Some(engine) = engine() {
        engine.playing = false;
        engine.pending.clear();
        engine.held.clear();
    }
}

/// Queries the pattern past `frame`, writes at most `free_records` event
/// records into `layout.records`, and refreshes
/// `layout.control`. Returns the number of records written, at most
/// `RECORD_CAPACITY`. Events beyond the capacity stay in the module for the
/// next turn, in onset order.
///
/// The glue publishes the control words first, then copies the records into
/// the ring. The renderer reads the ring tail before the control words, so a
/// record never meets control words older than its generation.
#[unsafe(no_mangle)]
pub extern "C" fn engine_turn(frame: f64, free_records: u32) -> u32 {
    let Some(engine) = engine() else { return 0 };
    if engine.playing {
        engine.fill(whole_frame(frame));
    }
    let written = engine.write_records(free_records as usize, whole_frame(frame));
    engine.publish();
    written as u32
}

/// Writes the position block, `layout.position`, from the state of the last
/// turn. The Worker which plays calls this after each `engine_turn` and copies
/// the words into the bridge, so a second Worker reads them when the first one
/// hangs. Units, as the words follow in `POSITION_WORDS`:
///
/// - the generation the control words carry,
/// - the first frame, on the audio clock, whose events are not all in the
///   ring: the queries reach this frame, and no event waits for room before
///   this frame,
/// - the anchor second and the anchor cycle of the mapping from seconds to
///   cycles, each as the bits of an `f64`,
/// - the tempo in cycles per second, as the bits of an `f64`,
/// - 1 while the engine plays, else 0,
/// - the events the renderer holds, as the engine counts them at the last turn,
/// - the low 32 bits of the frame of the last turn.
#[unsafe(no_mangle)]
pub extern "C" fn engine_position() {
    if let Some(engine) = engine() {
        engine.refresh_position();
    }
}

/// Continues the music of the position in `layout.position`. The Worker of a
/// standby calls this once, after the first Worker is gone: the glue copies the
/// position words of the bridge into `layout.position`, then passes the audio
/// frame of the call in `frame`.
///
/// The score of the engine plays from the first frame the other engine did not
/// cover, or `LEAD_FRAMES` after `frame` when this frame is past. The
/// generation is the next one after the generation of the position, and the
/// takeover frame is the frame the score starts on. The device drops the old
/// events from there on, so no onset sounds twice. The events of the first
/// engine which the renderer still holds count in the pool of the new engine,
/// so the new events do not fill the pool twice. An engine which did not play
/// takes the tempo and the generation count only.
///
/// Returns the generation the engine is on. A position with no finite anchor or
/// no tempo above 0 returns `FAILED` with the message in `layout.error` and
/// changes nothing.
#[unsafe(no_mangle)]
pub extern "C" fn engine_adopt(frame: f64) -> i32 {
    let Some(engine) = engine() else {
        return FAILED;
    };
    engine.adopt_position(whole_frame(frame))
}

/// The bytes of this module's canonical event, `layout.record_bytes` long.
/// Null before `engine_init`.
#[unsafe(no_mangle)]
pub extern "C" fn engine_canonical_event() -> *const u8 {
    engine().map_or(ptr::null(), |engine| {
        ptr::from_ref(&engine.canonical).cast()
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_long_message_is_cut_on_a_character_boundary() {
        // SAFETY: the layout lives in the module state until the next init.
        let layout = unsafe { engine_init(48_000).as_ref() }.expect("the engine starts");
        let message = format!("{}é", "a".repeat(ERROR_CAPACITY - 1));
        assert_eq!(engine().unwrap().fail(&message), FAILED);
        assert_eq!(layout.error_len.get() as usize, ERROR_CAPACITY - 1);
    }
}
