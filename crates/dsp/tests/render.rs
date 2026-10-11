//! Drives the exports on the host as the glue drives them in the browser.

use std::slice;

use rustel_audio::{AudioEvent, OscillatorControls};
use rustel_web_dsp::{
    ACCEPTED, DspLayout, GENERATION, QUANTUM, TELEMETRY_WORDS, dsp_allocations, dsp_init,
    dsp_render,
};
use rustel_web_wire::CONTROL_WORDS;

const RATE: u32 = 48_000;
/// The stop ramp is 10 ms.
const RAMP_FRAMES: usize = RATE as usize / 100;

/// One sine note with the generation of the first flip, due on frame 256.
fn sine() -> AudioEvent {
    AudioEvent {
        onset_id: 1,
        generation: 1,
        ui_visuals: 0,
        target_frame: 256,
        onset_lead: 0.0,
        freq_hz: 440.0,
        gain: 0.5,
        duration_secs: 60.0,
        controls: OscillatorControls::default(),
        sample: None,
        wavetable: None,
        synth: None,
        cut: None,
    }
}

/// Control words for generation 1, with a takeover at frame 0 and no cut.
fn control(stopped: bool) -> [u32; CONTROL_WORDS] {
    [1, 0, 0, 0, 0, 0, 0, 0, u32::from(stopped)]
}

/// Renders `quanta` quanta from `*frame` and returns every output float.
fn render(layout: &DspLayout, frame: &mut u64, quanta: usize, records: u32) -> Vec<f32> {
    let mut heard = Vec::new();
    for quantum in 0..quanta {
        dsp_render(*frame as f64, if quantum == 0 { records } else { 0 });
        // SAFETY: the layout points at the output area of the module.
        heard.extend_from_slice(unsafe { slice::from_raw_parts(layout.output, QUANTUM * 2) });
        *frame += QUANTUM as u64;
    }
    heard
}

fn peak(samples: &[f32]) -> f32 {
    samples
        .iter()
        .fold(0.0, |peak, sample| peak.max(sample.abs()))
}

#[test]
fn sine_plays_stops_and_allocates_nothing() {
    // SAFETY: the layout lives in the module state until the next init.
    let layout = unsafe { dsp_init(RATE, 64).as_ref() }.expect("the renderer starts");
    // SAFETY: the areas hold the sizes the layout documents.
    let (inbox, words, telemetry) = unsafe {
        (
            layout.inbox.cast::<AudioEvent>(),
            slice::from_raw_parts_mut(layout.control, CONTROL_WORDS),
            slice::from_raw_parts(layout.telemetry, TELEMETRY_WORDS),
        )
    };
    let mut frame = 0;
    words.copy_from_slice(&control(false));
    // SAFETY: the inbox holds 64 records.
    unsafe { inbox.write(sine()) };

    // The note starts on frame 256, so the first two quanta stay silent.
    let silent = render(layout, &mut frame, 2, 1);
    assert_eq!(peak(&silent), 0.0);
    assert_eq!(telemetry[ACCEPTED], 1);
    assert_eq!(telemetry[GENERATION], 1);
    let heard = render(layout, &mut frame, 398, 0);
    assert!(peak(&heard) > 0.01, "peak {}", peak(&heard));

    // The ramp sounds, then the output is exactly 0 from 10 ms plus one quantum.
    words.copy_from_slice(&control(true));
    let ramp = render(layout, &mut frame, 6, 0);
    assert!(peak(&ramp[..QUANTUM * 2]) > 0.0);
    let silent_from = (RAMP_FRAMES + QUANTUM) * 2;
    assert!(ramp[silent_from..].iter().all(|&sample| sample == 0.0));

    // Play on to 1,000 quanta in all.
    let rest = render(layout, &mut frame, 1000 - 406, 0);
    assert_eq!(peak(&rest), 0.0);
    assert_eq!(frame, 1000 * QUANTUM as u64);
    assert_eq!(dsp_allocations(), 0);
}
