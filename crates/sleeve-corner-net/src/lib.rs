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

/// A learned detection: the corner quad, plus — when the model has a heteroscedastic head
/// (`ml/train.py`) — the model's own per-corner positional uncertainty (`sigma`, in normalised
/// frame units; larger = less sure). `sigma` is `None` for an older single-output model, so the
/// wasm contract and callers stay backward-compatible.
pub struct NetDetection {
    pub quad: [f64; 8],
    pub sigma: Option<[f64; 4]>,
}

/// Core inference, native-testable (no wasm-bindgen). Returns the corner quad (TL,TR,BR,BL) and
/// optional per-corner uncertainty, or `None` on any failure.
pub fn detect(rgba: &[u8], width: u32, height: u32) -> Option<NetDetection> {
    let input = preprocess(rgba, width, height)?;
    let (corners, log_var) = with_model(|model| -> Option<(Vec<f32>, Option<Vec<f32>>)> {
        let out = model.run(tvec!(input.into())).ok()?;
        let corners = out[0].to_array_view::<f32>().ok()?.iter().copied().collect();
        // Second output (log-variance) only exists on a heteroscedastic model; absent on the
        // legacy single-output export, in which case there's no learned confidence.
        let log_var = out
            .get(1)
            .and_then(|o| o.to_array_view::<f32>().ok())
            .map(|v| v.iter().copied().collect());
        Some((corners, log_var))
    })?;
    if corners.len() != 8 || corners.iter().any(|v| !v.is_finite()) {
        return None;
    }
    let mut quad = [0f64; 8];
    for (i, v) in corners.iter().enumerate() {
        // sigmoid head already bounds the means to [0,1]; clamp defensively.
        quad[i] = (*v as f64).clamp(0.0, 1.0);
    }
    // Per-corner sigma from the 8 per-coordinate log-variances: sigma_coord = exp(0.5·log_var),
    // combined per corner as the RMS of its x/y sigmas. None unless the model emitted a valid
    // length-8 log_var.
    let sigma = log_var.and_then(|lv| {
        if lv.len() != 8 || lv.iter().any(|v| !v.is_finite()) {
            return None;
        }
        let s: Vec<f64> = lv.iter().map(|v| (0.5 * *v as f64).exp()).collect();
        Some([
            ((s[0] * s[0] + s[1] * s[1]) / 2.0).sqrt(),
            ((s[2] * s[2] + s[3] * s[3]) / 2.0).sqrt(),
            ((s[4] * s[4] + s[5] * s[5]) / 2.0).sqrt(),
            ((s[6] * s[6] + s[7] * s[7]) / 2.0).sqrt(),
        ])
    });
    Some(NetDetection { quad, sigma })
}

/// wasm entry point. Returns a flat `Vec<f64>`: the 8 normalised corners (TL,TR,BR,BL), followed
/// by 4 per-corner uncertainties (sigma) **when the model reports them** — so length is 8 for a
/// legacy model and 12 for a heteroscedastic one. Empty vec on failure. Same empty-on-failure
/// convention as `sleeve-detect`'s `detectSleeveCorners`.
#[wasm_bindgen(js_name = detectSleeveCornersNet)]
pub fn detect_sleeve_corners_net(rgba: &[u8], width: u32, height: u32) -> Vec<f64> {
    match detect(rgba, width, height) {
        Some(d) => {
            let mut out = d.quad.to_vec();
            if let Some(sigma) = d.sigma {
                out.extend_from_slice(&sigma);
            }
            out
        }
        None => Vec::new(),
    }
}
