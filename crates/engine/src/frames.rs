//! Frame arithmetic copied from the engine repository, file
//! `crates/runtime/src/render.rs`. The runtime crate pulls in files, threads
//! and network, so this crate does not depend on the runtime crate.

/// Converts the scheduler's floating onset time to the exact frame boundary
/// of the audio voice resolver.
///
/// Audio absorbs sub-picosecond floating dust before taking the first frame at
/// or after an onset. A takeover must make the identical decision, or an onset
/// on the boundary survives in one generation and is replaced in the other.
pub fn onset_frame_at(target_time: f64, sample_rate: u32) -> u64 {
    let exact_frame = target_time * f64::from(sample_rate);
    let nearest = exact_frame.round();
    let exact_frame = if (exact_frame - nearest).abs() < 1e-6 {
        nearest
    } else {
        exact_frame
    };
    let onset_frame = exact_frame.ceil();
    if !onset_frame.is_finite() || onset_frame < 0.0 || onset_frame > u64::MAX as f64 {
        u64::MAX
    } else {
        onset_frame as u64
    }
}

/// The first instant, in seconds, whose onset [`onset_frame_at`] puts on
/// `frame` or later: an onset is before this instant exactly when its frame
/// is before `frame`.
///
/// The edge is not `frame / sample_rate`. An onset takes the first frame at
/// or after its time, so the instants of `frame` begin past the frame before,
/// where the dust `onset_frame_at` absorbs ends.
pub fn onset_frame_edge(frame: u64, sample_rate: u32) -> f64 {
    /// The quotient below and the product in `onset_frame_at` each round,
    /// which leaves the estimate a few units in the last place off the edge.
    const SEARCH_STEPS: usize = 8;
    let rate = f64::from(sample_rate);
    if frame == 0 {
        // No onset is before the first frame. One frame before time zero
        // is earlier than each onset which `onset_frame_at` puts on a frame.
        return -1.0 / rate;
    }
    let mut edge = (frame as f64 - 1.0 + 1e-6) / rate;
    for _ in 0..SEARCH_STEPS {
        if onset_frame_at(edge, sample_rate) >= frame {
            break;
        }
        edge = edge.next_up();
    }
    for _ in 0..SEARCH_STEPS {
        let before = edge.next_down();
        if onset_frame_at(before, sample_rate) < frame {
            break;
        }
        edge = before;
    }
    edge
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn onset_frames_absorb_dust_and_round_up() {
        assert_eq!(onset_frame_at(0.8, 48_000), 38_400);
        assert_eq!(onset_frame_at(38_400.0000000005 / 48_000.0, 48_000), 38_400);
        assert_eq!(onset_frame_at(38_400.25 / 48_000.0, 48_000), 38_401);
        assert_eq!(onset_frame_at(f64::NAN, 48_000), u64::MAX);
        assert_eq!(onset_frame_at(-1.0, 48_000), u64::MAX);
    }

    /// The instant on the edge has the frame, and the instant one unit in the
    /// last place before the edge has an earlier one.
    #[test]
    fn the_edge_is_the_first_instant_on_its_frame() {
        for sample_rate in [8_000, 44_100, 48_000, 88_200, 96_000, 192_000] {
            let frames = (1..=4_096u64)
                .chain((0..40).map(|power| (1u64 << power) + 1))
                .chain((1..2_000).map(|step| step * 6_000 + 1_280))
                .chain([49_280, 16_800, 1_000_000_007, 172_800_000_000]);
            for frame in frames {
                let edge = onset_frame_edge(frame, sample_rate);
                assert!(
                    onset_frame_at(edge, sample_rate) >= frame,
                    "{sample_rate} Hz: the edge of frame {frame} is on an earlier frame"
                );
                assert!(
                    onset_frame_at(edge.next_down(), sample_rate) < frame,
                    "{sample_rate} Hz: an instant before the edge of frame {frame} is on the frame"
                );
            }
        }
    }

    #[test]
    fn the_edge_lies_just_past_the_frame_before() {
        let edge = onset_frame_edge(49_280, 48_000);
        assert!(49_279.0 / 48_000.0 < edge);
        assert!(49_279.000_000_5 / 48_000.0 < edge);
        assert!(49_279.7 / 48_000.0 >= edge);
        assert!(49_280.0 / 48_000.0 >= edge);
    }

    /// No onset is before the edge of the first frame, not even one before
    /// time zero which `onset_frame_at` puts on frame zero.
    #[test]
    fn no_onset_is_before_the_edge_of_the_first_frame() {
        let edge = onset_frame_edge(0, 48_000);
        assert!(edge.is_finite());
        for on_the_first_frame in [0.0, -0.000_000_5 / 48_000.0, -0.9 / 48_000.0] {
            assert_eq!(onset_frame_at(on_the_first_frame, 48_000), 0);
            assert!(on_the_first_frame >= edge);
        }
    }
}
