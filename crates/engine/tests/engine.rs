//! Drives the exports on the host as the Worker glue drives them in the
//! browser. The exports share one state, so one test runs every case.

use std::ops::RangeInclusive;
use std::{ptr, slice};

use rustel_audio::AudioEvent;
use rustel_core::Pattern;
use rustel_core::controls::default_control_registry;
use rustel_web_dsp::{
    ACCEPTED, DspLayout, INBOX_RECORDS, LATE, QUANTUM, REFUSED, STALE, TELEMETRY_WORDS,
    dsp_allocations, dsp_init, dsp_render,
};
use rustel_web_engine::binding::exports::bind_free;
use rustel_web_engine::binding::state::keep;
use rustel_web_engine::{
    EngineLayout, FAILED, LEAD_FRAMES, PLAY_LEAD_FRAMES, POSITION_WORDS, PUBLISHED_WORDS,
    RECORD_CAPACITY, SEND_BUDGET, TEXT_CAPACITY, engine_adopt, engine_canonical_event, engine_init,
    engine_play, engine_position, engine_set_cps, engine_set_pattern, engine_set_score,
    engine_stop, engine_turn,
};
use rustel_web_wire::{CONTROL_WORDS, canonical_event};

const RATE: u32 = 48_000;
/// The glue turns the engine every 10 ms.
const TURN: u64 = 480;
/// Frames of one cycle at 1 cycle per second.
const CYCLE: u64 = RATE as u64;
const NOTES: &str = "c3 e3 g3 c4";
const FREE: u32 = RECORD_CAPACITY as u32;

/// The engine as the glue sees the engine.
struct Glue(*const EngineLayout);

impl Glue {
    fn init() -> Self {
        let layout = engine_init(RATE);
        assert!(!layout.is_null());
        Self(layout)
    }

    fn layout(&self) -> &EngineLayout {
        // SAFETY: the layout lives in the module state until the next init.
        unsafe { &*self.0 }
    }

    /// Copies the bytes into the text buffer and sets the pattern.
    fn set_bytes(&self, text: &[u8], control: u32, waveform: u32, frame: u64) -> i32 {
        // SAFETY: the text buffer holds `text_capacity` bytes.
        unsafe { ptr::copy_nonoverlapping(text.as_ptr(), self.layout().text, text.len()) };
        engine_set_pattern(text.len() as u32, control, waveform, frame as f64)
    }

    fn set(&self, text: &str, control: u32, waveform: u32, frame: u64) -> i32 {
        self.set_bytes(text.as_bytes(), control, waveform, frame)
    }

    fn message(&self) -> String {
        let layout = self.layout();
        // SAFETY: the module wrote `error_len` bytes into the error buffer.
        let bytes = unsafe { slice::from_raw_parts(layout.error, layout.error_len.get() as usize) };
        String::from_utf8(bytes.to_vec()).expect("the message is UTF-8")
    }

    /// One turn, and the records written.
    fn turn(&self, frame: u64, free: u32) -> Vec<AudioEvent> {
        let count = engine_turn(frame as f64, free) as usize;
        assert!(count <= RECORD_CAPACITY.min(free as usize));
        // SAFETY: the first `count` records are written.
        let records = unsafe { slice::from_raw_parts(self.layout().records.cast(), count) };
        records.to_vec()
    }

    /// `turns` turns, one every 10 ms from frame `from`.
    fn run(&self, from: u64, turns: u64, free: u32) -> Vec<AudioEvent> {
        (0..turns)
            .flat_map(|turn| self.turn(from + turn * TURN, free))
            .collect()
    }

    /// The position block after `engine_position`, as the glue copies the words into the bridge.
    fn position(&self) -> [u32; POSITION_WORDS] {
        engine_position();
        let mut words = [0; POSITION_WORDS];
        // SAFETY: the position area holds `POSITION_WORDS` words.
        unsafe {
            ptr::copy_nonoverlapping(self.layout().position, words.as_mut_ptr(), words.len())
        };
        words
    }

    /// Writes the words of another engine into the position area.
    fn set_position(&self, words: &[u32; POSITION_WORDS]) {
        // SAFETY: the position area holds `POSITION_WORDS` words.
        unsafe { ptr::copy_nonoverlapping(words.as_ptr(), self.layout().position, words.len()) };
    }

    /// Generation and takeover frame of the published control words.
    fn published(&self) -> (u64, u64) {
        // SAFETY: the control area holds `PUBLISHED_WORDS` words.
        let words = unsafe { slice::from_raw_parts(self.layout().control, PUBLISHED_WORDS) };
        assert_eq!(words[4..], [0; 4], "no cut and no line arm");
        let value = |at: usize| u64::from(words[at]) | (u64::from(words[at + 1]) << 32);
        (value(0), value(2))
    }
}

/// Asserts the records are the notes at the frames, each within 0.01 Hz.
fn assert_notes(records: &[AudioEvent], notes: &[(u64, f32)]) {
    assert_eq!(records.len(), notes.len(), "{records:?}");
    for (record, &(frame, hz)) in records.iter().zip(notes) {
        assert_eq!(record.target_frame, frame, "{record:?}");
        assert!((record.freq_hz - hz).abs() < 0.01, "{record:?}");
    }
}

/// Four notes a cycle at 1 cps, then stop, then play again.
fn plays_stops_and_plays_again() {
    let glue = Glue::init();
    engine_set_cps(1.0, 0.0);
    assert_eq!(glue.set(NOTES, 0, 0, 0), 0);
    let play = 9_600;
    let start = play + PLAY_LEAD_FRAMES;
    engine_play(play as f64);
    let records = glue.run(play, 200, FREE);
    // Two seconds hold 8 onsets. The horizon of the last turn holds 8 more.
    let (in_two_secs, ahead): (Vec<&AudioEvent>, Vec<&AudioEvent>) = records
        .iter()
        .partition(|record| record.target_frame < start + 2 * CYCLE);
    assert_eq!((in_two_secs.len(), ahead.len()), (8, 8));
    let hz = [130.81, 164.81, 196.00, 261.63];
    for (k, record) in in_two_secs.iter().enumerate() {
        assert_eq!(record.target_frame, start + k as u64 * 12_000);
        assert!((record.freq_hz - hz[k % 4]).abs() < 0.01, "{record:?}");
        assert_eq!(record.generation, 1);
    }
    assert_eq!(glue.published(), (1, 0));
    assert_eq!(glue.layout().refused.get(), 0);

    // Stop drops what waits for room, and ends the records.
    let late = play + 230 * TURN;
    assert!(glue.turn(late, 0).is_empty());
    assert_eq!(glue.turn(late, 1).len(), 1, "an onset waits for room");
    engine_stop();
    assert!(glue.run(late, 50, FREE).is_empty());

    // Play starts at cycle 0 from the new frame, as a new generation.
    let again = 300_000;
    engine_play(again as f64);
    let first: Vec<_> = glue.run(again, 100, FREE).into_iter().take(4).collect();
    let notes = [
        (0, hz[0]),
        (12_000, hz[1]),
        (24_000, hz[2]),
        (36_000, hz[3]),
    ];
    assert_notes(
        &first,
        &notes.map(|(offset, hz)| (again + PLAY_LEAD_FRAMES + offset, hz)),
    );
    assert!(first.iter().all(|record| record.generation == 2));
    assert!(first[0].onset_id > in_two_secs[7].onset_id);
    assert_eq!(glue.published(), (2, 0));
}

/// An update at frame F takes over at F + 384, and bad text changes nothing.
fn updates_and_refuses_bad_text() {
    let glue = Glue::init();
    engine_set_cps(1.0, 0.0);
    glue.set(NOTES, 0, 0, 0);
    let play = 20_000;
    let start = play + PLAY_LEAD_FRAMES;
    engine_play(play as f64);
    // Two turns with no room leave the first three onsets waiting.
    assert!(glue.turn(play, 0).is_empty());
    assert!(glue.turn(play + 10_000, 0).is_empty());
    // The second onset falls 100 frames before the takeover.
    let update = start + 12_100 - LEAD_FRAMES;
    let takeover = update + LEAD_FRAMES;
    assert_eq!(glue.set("d3 f3 a3", 0, 0, update), 2);
    let records = glue.run(update, 100, FREE);
    assert_eq!(glue.published(), (2, takeover));

    // The old generation keeps the waiting onsets before the takeover only.
    let (old, new): (Vec<&AudioEvent>, Vec<&AudioEvent>) =
        records.iter().partition(|r| r.generation == 1);
    let old: Vec<_> = old.into_iter().copied().collect();
    assert_notes(&old, &[(start, 130.81), (start + 12_000, 164.81)]);
    assert!(old.iter().all(|record| record.target_frame < takeover));
    // The new one starts at the takeover and keeps the phase of the cycle.
    assert!(new.iter().all(|record| record.target_frame >= takeover));
    let new: Vec<_> = new.into_iter().copied().collect();
    let hz = [174.61, 220.0, 146.83].into_iter().cycle();
    let expected: Vec<_> = (1..=9)
        .zip(hz)
        .map(|(third, hz)| (start + third * CYCLE / 3, hz))
        .collect();
    assert_notes(&new, &expected);

    // Bad text returns a negative value and a message, and the pattern plays on.
    let now = update + 100 * TURN;
    assert!(glue.set("c3 [e3", 0, 0, now) < 0);
    assert!(
        glue.message().starts_with("[mini] parse error"),
        "{}",
        glue.message()
    );
    let later = glue.run(now, 100, FREE);
    assert!(!later.is_empty());
    assert!(later.iter().all(|record| record.generation == 2));
    assert_eq!(glue.published().0, 2);
    // Other failures say why, and a success clears the message.
    assert_eq!(glue.set("c3", 7, 0, now), FAILED);
    assert_eq!(glue.set("c3", 0, 4, now), FAILED);
    assert_eq!(glue.set_bytes(&[0xff], 0, 0, now), FAILED);
    assert!(glue.message().contains("UTF-8"), "{}", glue.message());
    assert_eq!(
        engine_set_pattern(TEXT_CAPACITY as u32 + 1, 0, 0, 0.0),
        FAILED
    );
    assert!(glue.message().contains("longer"), "{}", glue.message());
    assert_eq!(glue.published().0, 2);
    assert_eq!(glue.set("c3", 0, 0, now + 100 * TURN), 3);
    assert_eq!(glue.layout().error_len.get(), 0);
}

/// Two updates before a turn publish the second one alone, and the device
/// keeps the old generation up to its takeover. No onset is lost or doubled.
fn updates_twice_before_a_turn() {
    let glue = Glue::init();
    engine_set_cps(1.0, 0.0);
    glue.set(NOTES, 0, 0, 0);
    let play = 20_000;
    let start = play + PLAY_LEAD_FRAMES;
    engine_play(play as f64);
    // The old onset on start + 12000 falls between the two takeovers.
    assert!(glue.run(play, 10, 0).is_empty());
    let first = start + 11_900 - LEAD_FRAMES;
    let second = first + 200;
    assert_eq!(glue.set("d3 e3 g3 c4", 0, 0, first), 2);
    assert_eq!(glue.set("e3 e3 e3 e3", 0, 0, second), 3);
    let takeover = second + LEAD_FRAMES;
    assert!(start + 12_000 > first + LEAD_FRAMES && start + 12_000 < takeover);
    let records = glue.run(second, 200, FREE);
    assert_eq!(glue.published(), (3, takeover));
    let heard: Vec<_> = records
        .iter()
        .filter(|record| record.generation == 3 || record.target_frame < takeover)
        .collect();
    assert!(heard.len() > 8);
    for (k, record) in heard.iter().enumerate() {
        assert_eq!(record.target_frame, start + k as u64 * 12_000);
    }
}

/// A tempo change takes over at F + 384 and keeps the phase.
fn changes_tempo() {
    let glue = Glue::init();
    engine_set_cps(1.0, 0.0);
    glue.set("c3", 0, 0, 0);
    engine_play(0.0);
    glue.turn(0, FREE);
    // The takeover sits `takeover - PLAY_LEAD_FRAMES` frames into the first
    // cycle. The next onset is the rest of the cycle away, which takes half as
    // many frames at 2 cps.
    engine_set_cps(2.0, 10_000.0);
    let records = glue.run(10_000, 100, FREE);
    let takeover = 10_000 + LEAD_FRAMES;
    let first = takeover + (CYCLE - (takeover - PLAY_LEAD_FRAMES)) / 2;
    assert_eq!(records.len(), 6);
    for (k, record) in records.iter().enumerate() {
        assert_eq!(record.target_frame, first + k as u64 * CYCLE / 2);
        assert_eq!(record.generation, 2);
    }
    assert_eq!(glue.published(), (2, takeover));
    // A tempo which is not a rate changes nothing.
    engine_set_cps(f64::NAN, 20_000.0);
    engine_set_cps(0.0, 20_000.0);
    assert_eq!(glue.published(), (2, takeover));
}

/// Sound names resolve, and an unknown one is skipped and counted.
fn plays_sound_names() {
    let glue = Glue::init();
    engine_set_cps(4.0, 0.0);
    glue.set("bd foo", 1, 0, 0);
    engine_play(0.0);
    // The first turn reaches 0.5 s, which holds two cycles: two of each name.
    let records = glue.turn(0, FREE);
    assert_eq!(records.len(), 2);
    assert!(records.iter().all(|record| record.sample.is_some()));
    assert_eq!(glue.layout().refused.get(), 2);
    // The reach grows by 0.5 s on each turn, to the horizon of 2 s. The fourth
    // turn is 30 ms in, so the turn reaches 2.03 s: 8 cycles and the first name of the ninth.
    let more: usize = (1..4).map(|turn| glue.turn(turn * TURN, FREE).len()).sum();
    assert_eq!(records.len() + more, 9);
    assert_eq!(glue.layout().refused.get(), 8);
}

/// The renderer module as the glue feeds the module: records and control words in, samples out.
struct Sound {
    dsp: &'static DspLayout,
    heard: Vec<f32>,
    delivered: u32,
}

impl Sound {
    fn new() -> Self {
        // SAFETY: the layout lives in the module state until the next init.
        let dsp = unsafe { &*dsp_init(RATE, 64) };
        Self {
            dsp,
            heard: Vec::new(),
            delivered: 0,
        }
    }

    /// Copies the records and the control words into the areas, then renders
    /// up to the frame `until`.
    fn feed(&mut self, records: &[AudioEvent], control: (u64, u64), until: u64) {
        let dsp = self.dsp;
        for (at, record) in records.iter().enumerate() {
            // SAFETY: the inbox holds 64 records of `record_bytes` bytes.
            unsafe {
                let bytes = ptr::from_ref(record).cast();
                ptr::copy_nonoverlapping(
                    bytes,
                    dsp.inbox.add(at * dsp.record_bytes),
                    dsp.record_bytes,
                );
            }
        }
        self.delivered += records.len() as u32;
        // SAFETY: the control area holds `CONTROL_WORDS` words.
        let words = unsafe { slice::from_raw_parts_mut(dsp.control, CONTROL_WORDS) };
        for (at, value) in [control.0, control.1].into_iter().enumerate() {
            words[at * 2] = value as u32;
            words[at * 2 + 1] = (value >> 32) as u32;
        }
        let mut count = records.len() as u32;
        while self.heard.len() as u64 / 2 < until {
            dsp_render((self.heard.len() / 2) as f64, count);
            count = 0;
            // SAFETY: the output area holds one quantum of stereo floats.
            self.heard
                .extend_from_slice(unsafe { slice::from_raw_parts(dsp.output, QUANTUM * 2) });
        }
    }

    /// Accepted, late, stale and refused events of the renderer.
    fn counts(&self) -> [u32; 4] {
        // SAFETY: the telemetry area holds `TELEMETRY_WORDS` words.
        let words = unsafe { slice::from_raw_parts(self.dsp.telemetry, TELEMETRY_WORDS) };
        [words[ACCEPTED], words[LATE], words[STALE], words[REFUSED]]
    }
}

/// The records drive the renderer. A rest makes silence between the notes.
fn sounds_in_the_renderer() {
    let glue = Glue::init();
    engine_set_cps(1.0, 0.0);
    glue.set("c3 ~ g3 ~", 0, 0, 0);
    engine_play(0.0);
    let mut sound = Sound::new();
    for turn in 0..100 {
        let records = glue.turn(turn * TURN, INBOX_RECORDS as u32);
        sound.feed(&records, glue.published(), (turn + 1) * TURN);
    }
    let heard = &sound.heard;
    let peak = |from: u64, to: u64| {
        heard[from as usize * 2..to as usize * 2]
            .iter()
            .fold(0.0_f32, |peak, sample| peak.max(sample.abs()))
    };
    let first_sound = |from: u64| {
        heard[from as usize * 2..]
            .chunks(2)
            .position(|frame| frame != [0.0, 0.0])
            .map(|at| from + at as u64)
    };
    let (first, second) = (PLAY_LEAD_FRAMES, PLAY_LEAD_FRAMES + 24_000);
    assert_eq!(peak(0, first), 0.0, "silence before the first onset");
    assert!((first..=first + 2).contains(&first_sound(0).unwrap()));
    assert!(peak(first, first + 480) > 0.05);
    assert_eq!(peak(first + 12_600, second), 0.0, "the rest is silent");
    assert!((second..=second + 2).contains(&first_sound(first + 12_600).unwrap()));
    assert!(peak(second, second + 480) > 0.05);
    let [accepted, late, stale, refused] = sound.counts();
    assert_eq!(accepted, sound.delivered);
    assert_eq!((late, stale, refused), (0, 0, 0));
    assert_eq!(dsp_allocations(), 0);
}

/// The pattern of the sound names (control 1), as `engine_set_pattern` builds the pattern.
fn sounds(text: &str) -> Pattern {
    let steps = rustel_mini::mini(text).expect("the text parses");
    let control = default_control_registry().get("s").expect("the control s");
    control.standalone(&steps)
}

/// A pattern behind a handle plays as the same text does and takes over by the
/// same rules. The engine keeps its own reference.
fn plays_a_score_pattern() {
    let glue = Glue::init();
    engine_set_cps(1.0, 0.0);
    glue.set("bd bd", 1, 0, 0);
    engine_play(0.0);
    let by_text = glue.run(0, 100, FREE);
    assert!(!by_text.is_empty());

    let glue = Glue::init();
    engine_set_cps(1.0, 0.0);
    let first = keep(sounds("bd bd"));
    assert_eq!(engine_set_score(first, 0.0), 0);
    engine_play(0.0);
    assert_eq!(glue.run(0, 100, FREE), by_text);

    let update = 40_000;
    let second = keep(sounds("bd"));
    assert_eq!(engine_set_score(second, update as f64), 2);
    glue.run(update, 10, FREE);
    assert_eq!(glue.published(), (2, update + LEAD_FRAMES));
    bind_free(first);
    bind_free(second);
    let later = glue.run(update + 10 * TURN, 100, FREE);
    assert!(!later.is_empty() && later.iter().all(|record| record.generation == 2));

    // A handle which names no live pattern changes nothing.
    assert_eq!(engine_set_score(first, 50_000.0), FAILED);
    assert!(
        glue.message().contains("no live pattern"),
        "{}",
        glue.message()
    );
    assert_eq!(engine_set_score(u32::MAX, 50_000.0), FAILED);
    assert_eq!(glue.published().0, 2);
}

/// Few free records only delay the events, in onset order.
fn delivers_every_event_with_few_free_records() {
    let glue = Glue::init();
    engine_set_cps(4.0, 0.0);
    glue.set("c3*8", 0, 0, 0);
    engine_play(0.0);
    let all = glue.run(0, 100, FREE);
    assert!(all.len() > 40);
    engine_play(0.0);
    let mut slow = Vec::new();
    for turn in 0..100 {
        let records = glue.turn(turn * TURN, 1);
        assert!(records.len() <= 1);
        slow.extend(records);
    }
    assert_eq!(slow.len(), all.len());
    for (slow, all) in slow.iter().zip(&all) {
        assert_eq!(slow.target_frame, all.target_frame);
    }
    assert!(
        slow.windows(2)
            .all(|pair| pair[0].onset_id < pair[1].onset_id)
    );
}

/// The renderer holds the events of the ring until their sound ends. The pool of
/// events written and not ended: the note and its release.
fn pool(written: &[AudioEvent], frame: u64) -> usize {
    written
        .iter()
        .filter(|event| {
            let ends = f64::from(event.duration_secs + event.controls.envelope.release_secs);
            event.target_frame + (ends * f64::from(RATE)).ceil() as u64 > frame
        })
        .count()
}

/// A dense score reaches only as far ahead as the budget allows. The pool of the
/// renderer never passes the budget, and the events are the events of the score,
/// one at each onset, in order. The renderer refuses none and takes none late.
fn holds_the_budget_with_a_dense_score() {
    let glue = Glue::init();
    engine_set_cps(1.0, 0.0);
    glue.set("c3*96", 0, 0, 0);
    let play = 4_800;
    let start = play + PLAY_LEAD_FRAMES;
    engine_play(play as f64);
    let mut sound = Sound::new();
    let (mut written, mut widest) = (Vec::new(), 0);
    for turn in 0..400 {
        let frame = play + turn * TURN;
        let records = glue.turn(frame, FREE);
        assert!(records.len() <= SEND_BUDGET);
        sound.feed(&records, glue.published(), frame + TURN);
        written.extend(records);
        let held = pool(&written, frame);
        assert!(held <= SEND_BUDGET, "{held} events held at frame {frame}");
        widest = widest.max(held);
    }
    // The first turn fills the budget, and the pool stays near the budget.
    assert!(widest >= SEND_BUDGET - 2, "{widest}");
    // One event at each onset of 96 a second: none skipped, none doubled.
    for (k, event) in written.iter().enumerate() {
        assert_eq!(event.target_frame, start + k as u64 * CYCLE / 96, "{k}");
        assert_eq!(event.onset_id, k as u64);
    }
    // The last turn covers 60 events, which is 0.625 s.
    let last = play + 399 * TURN;
    let ahead = written.last().unwrap().target_frame - last;
    assert!((28_000..=30_000).contains(&ahead), "{ahead}");
    let [_, late, _, refused] = sound.counts();
    assert_eq!((late, refused), (0, 0));

    // A play while playing starts again, drops the events which wait, and the
    // budget starts again.
    engine_play(100_000.0);
    let again = glue.turn(100_000, FREE);
    assert!((1..=SEND_BUDGET).contains(&again.len()));
    assert_eq!(again[0].target_frame, 100_000 + PLAY_LEAD_FRAMES);
    assert!(again.iter().all(|record| record.generation == 2));
}

/// The first engine makes turns 0 to `HANG_TURN`, then hangs. One second later
/// the second engine makes its first turn, at `PROMOTE_TURN`.
const HANG_TURN: u64 = 150;
const PROMOTE_TURN: u64 = 250;
const END_TURN: u64 = 700;

/// The calls of the page before the hang: a play, a new tempo and an update.
/// The update is the last good score.
fn history(glue: &Glue, turn: u64, notes: &str, update: &str) {
    let frame = turn * TURN;
    match turn {
        0 => {
            engine_set_cps(1.0, 0.0);
            glue.set(notes, 0, 0, 0);
            engine_play(0.0);
        }
        60 => engine_set_cps(1.5, frame as f64),
        100 => {
            glue.set(update, 0, 0, frame);
        }
        _ => {}
    }
}

/// The event without the fields a second engine counts on its own.
fn same_event(event: &AudioEvent) -> AudioEvent {
    AudioEvent {
        onset_id: 0,
        generation: 0,
        ..*event
    }
}

/// A second engine continues the music from the position of a first engine
/// which hangs. From the takeover frame on, the second engine makes the events
/// the first one would have made, and the renderer plays the same samples.
/// `cover` is the frames past the last turn which the first engine covers.
fn continues_in_a_second_engine(notes: &str, update: &str, cover: RangeInclusive<u64>) {
    // The reference: the first engine makes every turn.
    let glue = Glue::init();
    let mut reference = Sound::new();
    let mut expected = Vec::new();
    for turn in 0..END_TURN {
        history(&glue, turn, notes, update);
        let records = glue.turn(turn * TURN, FREE);
        reference.feed(&records, glue.published(), (turn + 1) * TURN);
        expected.extend(records);
    }

    // The run with a hang. The renderer keeps the old words and plays the
    // events already in the ring.
    let glue = Glue::init();
    let mut promoted = Sound::new();
    for turn in 0..HANG_TURN {
        history(&glue, turn, notes, update);
        let records = glue.turn(turn * TURN, FREE);
        promoted.feed(&records, glue.published(), (turn + 1) * TURN);
    }
    let words = glue.position();
    let (generation, hung) = (3, (HANG_TURN - 1) * TURN);
    assert_eq!(glue.published().0, generation);
    let at = |index: usize| u64::from(words[index]) | (u64::from(words[index + 1]) << 32);
    assert_eq!(at(0), generation);
    let covered = at(2);
    assert!(
        (hung + cover.start()..=hung + cover.end()).contains(&covered),
        "{covered}"
    );
    assert_eq!(words[10], 1);
    for turn in HANG_TURN..PROMOTE_TURN {
        promoted.feed(&[], glue.published(), (turn + 1) * TURN);
    }

    // The second engine holds the last good score, and takes the position.
    let second = Glue::init();
    second.set(update, 0, 0, 0);
    second.set_position(&words);
    let promote = PROMOTE_TURN * TURN;
    assert_eq!(engine_adopt(promote as f64), generation as i32 + 1);
    // Until its queries reach the takeover frame, the ring holds the old events.
    let adopted = second.position();
    let at_adopted =
        |index: usize| u64::from(adopted[index]) | (u64::from(adopted[index + 1]) << 32);
    assert_eq!((at_adopted(0), at_adopted(2)), (generation + 1, covered));
    let mut got = Vec::new();
    for turn in PROMOTE_TURN..END_TURN {
        let records = second.turn(turn * TURN, FREE);
        promoted.feed(&records, second.published(), (turn + 1) * TURN);
        got.extend(records);
    }
    // The takeover frame is the first frame the first engine did not cover.
    assert_eq!(second.published(), (generation + 1, covered));
    assert!(covered > promote + LEAD_FRAMES);

    // The same events from the takeover frame on, up to the end of the shorter reach.
    let reach = (END_TURN - 1) * TURN + 48_000;
    let heard = |events: &[AudioEvent]| -> Vec<AudioEvent> {
        events
            .iter()
            .filter(|event| (covered..reach).contains(&event.target_frame))
            .map(same_event)
            .collect()
    };
    let (expected_events, got_events) = (heard(&expected), heard(&got));
    assert!(expected_events.len() > 15);
    assert!(covered > hung);
    assert_eq!(got_events, expected_events);
    assert!(got.iter().all(|event| event.generation == generation + 1));
    assert!(got.iter().all(|event| event.target_frame >= covered));

    // No onset is doubled or lost: the samples are the samples of the run with no hang.
    let first_difference = promoted
        .heard
        .iter()
        .zip(&reference.heard)
        .position(|(promoted, reference)| promoted != reference);
    assert_eq!(first_difference, None);
    assert_eq!(promoted.heard.len(), reference.heard.len());
    let [accepted, late, _, refused] = promoted.counts();
    assert_eq!((late, refused), (0, 0));
    assert!(accepted > 0);
}

/// A position of an engine which does not play carries the tempo and the count
/// of generations. A position with no tempo changes nothing.
fn adopts_a_stopped_position() {
    let glue = Glue::init();
    engine_set_cps(2.0, 0.0);
    glue.set(NOTES, 0, 0, 0);
    engine_play(0.0);
    glue.run(0, 10, FREE);
    engine_stop();
    glue.turn(10 * TURN, FREE);
    let words = glue.position();
    assert_eq!((words[0], words[2], words[3], words[10]), (1, 0, 0, 0));

    let second = Glue::init();
    second.set(NOTES, 0, 0, 0);
    second.set_position(&words);
    assert_eq!(engine_adopt(0.0), 1);
    assert!(second.turn(0, FREE).is_empty(), "the engine stays stopped");
    assert_eq!(second.published(), (1, 0));
    // The next play is the next generation, at the tempo of the position.
    let again = 100_000;
    engine_play(again as f64);
    let records = second.run(again, 20, FREE);
    assert_eq!(second.published(), (2, 0));
    assert_eq!(records[1].target_frame - records[0].target_frame, CYCLE / 8);

    // Words which are no position are refused, and the engine stays unchanged.
    second.set_position(&[0; POSITION_WORDS]);
    assert_eq!(engine_adopt(0.0), FAILED);
    assert!(
        second.message().contains("position"),
        "{}",
        second.message()
    );
    assert_eq!(second.published(), (2, 0));
}

#[test]
fn engine_exports() {
    assert!(engine_canonical_event().is_null(), "no event before init");
    plays_stops_and_plays_again();
    // SAFETY: the bytes are an event, as the glue copies them.
    let canonical = unsafe { engine_canonical_event().cast::<AudioEvent>().read() };
    assert_eq!(canonical, canonical_event());
    updates_and_refuses_bad_text();
    updates_twice_before_a_turn();
    changes_tempo();
    plays_sound_names();
    sounds_in_the_renderer();
    plays_a_score_pattern();
    delivers_every_event_with_few_free_records();
    holds_the_budget_with_a_dense_score();
    // The queries of a sparse score reach 2 s past the last turn, less one
    // refill step of 50 ms. A dense score is covered by its budget: 60 events at
    // 48 a second.
    continues_in_a_second_engine("c3 e3 g3 c4", "d3 f3 a3", 93_600..=96_000);
    continues_in_a_second_engine("c3*32", "d3*32", 54_000..=66_000);
    adopts_a_stopped_position();
}
