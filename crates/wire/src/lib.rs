//! What the engine module and the renderer module agree on.
//!
//! The two modules build the same `rustel-audio` source. An event record is
//! the bytes of an `AudioEvent`, so a build with another layout must stop the
//! page before the first record moves.

use rustel_audio::{
    AudioEvent, DelayControls, FilterStages, OscillatorControls, ReverbControls, SampleControls,
    SampleHold, SampleId, StaticBiquad, SynthSource, Waveform,
};

/// `u32` words of the control block. Four `u64` values, each as a low word
/// then a high word: generation (words 0 and 1), takeover frame (2 and 3),
/// takeover cut (4 and 5) and line arm (6 and 7). Then the stop flag, 0 or 1
/// (word 8). The engine module publishes words 0 to 7. The page owns word 8.
pub const CONTROL_WORDS: usize = 9;

/// One event with many fields away from their defaults. Each module builds
/// this event. The engine module exports its bytes, and the renderer module
/// compares them with its own event, so a layout difference between the two
/// builds stops the page.
pub fn canonical_event() -> AudioEvent {
    let mut event = AudioEvent {
        onset_id: 0x0102_0304_0506_0708,
        generation: 9,
        ui_visuals: 0x8000_0000_0000_0001,
        target_frame: 123_456_789_012,
        onset_lead: 0.25,
        freq_hz: 261.625_55,
        gain: 0.125,
        duration_secs: 1.5,
        controls: OscillatorControls::default(),
        sample: None,
        wavetable: None,
        synth: None,
        cut: Some(2.0),
    };
    let controls = &mut event.controls;
    controls.orbit = 3;
    controls.pan = Some(0.25);
    controls.waveform = Waveform::Square;
    controls.filters.stages = FilterStages::Two;
    controls.filters.lowpass = Some(StaticBiquad {
        frequency_hz: 900.0,
        q: 1.0,
    });
    controls.delay = Some(DelayControls {
        wet: 0.5,
        time_secs: 0.05,
        feedback: 0.75,
    });
    controls.reverb = Some(ReverbControls {
        wet: 0.5,
        size_secs: 2.0,
        fade_secs: 0.1,
        lp_start_hz: 15_000.0,
        lp_end_hz: 1_000.0,
        ir: None,
    });
    event.synth = Some(SynthSource::Supersaw {
        voices: 7.0,
        freqspread: 0.3,
        panspread: 0.4,
    });
    event.sample = Some(SampleControls {
        sample: SampleId(42),
        playback_rate: 0.5,
        begin: 0.125,
        end: 0.875,
        hold: SampleHold::Hap,
        muted: false,
        loop_secs: Some((0.1, 0.2)),
        envelope_peak: 0.3,
        reversed: true,
        nudge_secs: 0.01,
        cut: Some(4.0),
    });
    event
}
