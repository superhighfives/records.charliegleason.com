//! Learned sleeve-corner detector (wasm).
//!
//! A MobileNetV3-small corner-regressor (trained offline — see `ml/README.md`) exported to
//! ONNX and run with [`tract`], which is pure Rust and compiles to wasm. The model is embedded
//! in the binary (`include_bytes!`) and parsed+optimised once per isolate, then reused.
//!
//! Contract mirrors `sleeve-detect` so the worker calls it identically:
//! `detectSleeveCornersNet(rgba, width, height) -> Float64Array` of length 8 = normalised
//! `[x0,y0,..x3,y3]` in TL,TR,BR,BL order, or an empty array on any failure.
//!
//! Why this exists: the segmentation detector (`sleeve-detect`) bails on ~14% of captures
//! (dark/pale sleeves filling the frame, busy artwork) where there's no separable background.
//! This model was validated to cut that tail's median corner error from ~41% to ~1.8% of the
//! frame (5-fold out-of-fold); see `ml/README.md` and the backlog plan for the full comparison.

use tract_onnx::prelude::*;
use wasm_bindgen::prelude::*;

/// The trained model (fp32 ONNX). Normalisation (ImageNet mean/std) is baked into the graph,
/// so the input is a plain 1x3xSIDExSIDE f32 tensor in [0,1], RGB, NCHW.
static MODEL_BYTES: &[u8] = include_bytes!("../model/corner_model.onnx");

// Model input side. 384 (not 224) — the larger input localises edges noticeably better
// (offline median corner error 1.38% -> 1.16% with the edge-refine step); see ml/README.md.
const SIDE: usize = 384;

type Runnable = RunnableModel<TypedFact, Box<dyn TypedOp>, Graph<TypedFact, Box<dyn TypedOp>>>;

thread_local! {
    // Parsed+optimised once per isolate. `into_optimized()` is the expensive step (~tens of
    // ms), so it must not run per call.
    static MODEL: std::cell::OnceCell<Runnable> = const { std::cell::OnceCell::new() };
}

/// Run `f` with the isolate's single parsed+optimised model (built on first use).
fn with_model<T>(f: impl FnOnce(&Runnable) -> T) -> T {
    MODEL.with(|cell| {
        let m =
            cell.get_or_init(|| build_model().expect("embedded corner_model.onnx failed to load"));
        f(m)
    })
}

fn build_model() -> TractResult<Runnable> {
    tract_onnx::onnx()
        .model_for_read(&mut &MODEL_BYTES[..])?
        .with_input_fact(0, f32::fact([1, 3, SIDE, SIDE]).into())?
        .into_optimized()?
        .into_runnable()
}

/// Resize an RGBA buffer to SIDExSIDE and pack it as an NCHW f32 tensor in [0,1] (RGB, alpha
/// dropped). The whole frame is squashed to SIDExSIDE (aspect not preserved) — matching how the
/// model was trained (`cv2.resize(capture, (SIDE,SIDE))`), and corners are normalised to the
/// frame either way so it stays consistent.
fn preprocess(rgba: &[u8], width: u32, height: u32) -> Option<Tensor> {
    if width == 0 || height == 0 {
        return None;
    }
    if rgba.len() != (width as usize) * (height as usize) * 4 {
        return None;
    }
    let src = image::RgbaImage::from_raw(width, height, rgba.to_vec())?;
    let resized = image::imageops::resize(
        &src,
        SIDE as u32,
        SIDE as u32,
        image::imageops::FilterType::Triangle,
    );
    // NCHW: channel-planar. tensor[c][y][x] = pixel(x,y).channel(c) / 255
    let mut data = vec![0f32; 3 * SIDE * SIDE];
    for y in 0..SIDE {
        for x in 0..SIDE {
            let p = resized.get_pixel(x as u32, y as u32);
            let idx = y * SIDE + x;
            data[idx] = p[0] as f32 / 255.0; // R plane
            data[SIDE * SIDE + idx] = p[1] as f32 / 255.0; // G plane
            data[2 * SIDE * SIDE + idx] = p[2] as f32 / 255.0; // B plane
        }
    }
    Tensor::from_shape(&[1, 3, SIDE, SIDE], &data).ok()
}

/// Core inference, native-testable (no wasm-bindgen). Returns 8 normalised corner values
/// (TL,TR,BR,BL) or `None` on any failure.
pub fn detect(rgba: &[u8], width: u32, height: u32) -> Option<[f64; 8]> {
    let input = preprocess(rgba, width, height)?;
    let vals = with_model(|model| -> Option<Vec<f32>> {
        let out = model.run(tvec!(input.into())).ok()?;
        Some(
            out[0]
                .to_array_view::<f32>()
                .ok()?
                .iter()
                .copied()
                .collect(),
        )
    })?;
    if vals.len() != 8 || vals.iter().any(|v| !v.is_finite()) {
        return None;
    }
    let mut quad = [0f64; 8];
    for (i, v) in vals.iter().enumerate() {
        // sigmoid head already bounds to [0,1]; clamp defensively.
        quad[i] = (*v as f64).clamp(0.0, 1.0);
    }
    Some(quad)
}

/// wasm entry point. Returns a flat length-8 `Vec<f64>` (TL,TR,BR,BL normalised) or an empty
/// vec on failure — same convention as `sleeve-detect`'s `detectSleeveCorners`.
#[wasm_bindgen(js_name = detectSleeveCornersNet)]
pub fn detect_sleeve_corners_net(rgba: &[u8], width: u32, height: u32) -> Vec<f64> {
    match detect(rgba, width, height) {
        Some(q) => q.to_vec(),
        None => Vec::new(),
    }
}
