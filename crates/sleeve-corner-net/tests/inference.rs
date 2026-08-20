//! Native correctness test: the embedded model, run through tract on the real capture fixture,
//! must reproduce the reference onnxruntime output. This guards the wasm-free code path
//! (preprocess + tract inference); wasm-specific wiring is covered by the app integration.
//!
//! The fixture `capture_224.png` is a real capture (record #4) resized to 224x224; `EXPECTED`
//! is onnxruntime's output for the same input (see ml/README.md). Run: `cargo test`.

use image::GenericImageView;

// onnxruntime reference for capture_224.png (TL,TR,BR,BL normalised).
const EXPECTED: [f64; 8] = [
    0.0872, 0.0791, 0.9754, 0.1311, 0.9624, 0.9891, 0.0299, 0.9731,
];

#[test]
fn matches_onnxruntime_reference() {
    let img = image::load_from_memory(include_bytes!("fixtures/capture_224.png"))
        .expect("decode fixture");
    let (w, h) = img.dimensions();
    let rgba = img.to_rgba8().into_raw();

    let got = sleeve_corner_net::detect(&rgba, w, h).expect("detect returned None");

    let max_diff = got
        .iter()
        .zip(EXPECTED.iter())
        .map(|(a, b)| (a - b).abs())
        .fold(0.0f64, f64::max);
    assert!(
        max_diff < 0.03,
        "tract output diverged from onnxruntime reference: max|Δ|={max_diff:.4}\n got={got:?}\n exp={EXPECTED:?}"
    );

    // sanity: a plausible near-frame sleeve quad
    for v in got {
        assert!((0.0..=1.0).contains(&v));
    }
}

#[test]
fn rejects_malformed_input() {
    // wrong buffer length for the declared dimensions -> None
    assert!(sleeve_corner_net::detect(&[0u8; 10], 4, 4).is_none());
    // zero dimensions -> None
    assert!(sleeve_corner_net::detect(&[], 0, 0).is_none());
}
