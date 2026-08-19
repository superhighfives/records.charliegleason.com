//! Sleeve-corner detection by foreground segmentation: a replacement for both the
//! narrow-band luminance scan in `src/lib/photo-processing.ts`'s `detectSleeveCorners` and
//! the earlier whole-frame Canny/contour approach. On real captures the edge approach
//! failed two ways — the sleeve's own border is often lower-contrast than the artwork
//! inside it (so the "largest contour" locks onto the cover's subject), and a hairline
//! sleeve edge doesn't reliably close into one contour at native resolution.
//!
//! A record capture is a rectangular sleeve on a roughly-uniform surface, so it segments
//! cleanly: estimate the background colour from the frame border, take every pixel far
//! enough from it as foreground, keep the largest blob, and fit a minimum-area rotated
//! rectangle to it. Interior artwork is irrelevant, and the result is always a proper
//! convex quad. A rectangularity gate (does the blob actually fill its own rectangle?)
//! rejects covers that don't separate from their background, so the caller bails to manual
//! cropping instead of seeding a crop around the artwork's subject.
//!
//! Mirrors the TS side's conventions exactly so the two are interchangeable: input is a
//! plain RGBA buffer (`RgbaImage` on the TS side), output is four [x, y] corners in
//! TL, TR, BR, BL order, normalised to 0..1 of the image, or nothing if no confident quad
//! is found.

use image::{GrayImage, Luma, RgbaImage as ImageRgbaImage};
use imageproc::distance_transform::Norm;
use imageproc::filter::median_filter;
use imageproc::morphology::{close, dilate};
use imageproc::region_labelling::{Connectivity, connected_components};
use std::collections::{HashMap, HashSet};
use wasm_bindgen::prelude::*;

#[wasm_bindgen(start)]
pub fn init() {
    #[cfg(feature = "console_error_panic_hook")]
    console_error_panic_hook::set_once();
}

/// A corner as [x, y] in pixel coordinates.
type Corner = (f64, f64);
/// Four corners in TL, TR, BR, BL order (clockwise from top-left).
type Corners = [Corner; 4];

/// Detect the sleeve's four corners in an RGBA image.
///
/// `rgba` is `width * height * 4` bytes (R,G,B,A per pixel — same layout as a canvas
/// `ImageData`/`Uint8ClampedArray`, which is what the TS caller already has in hand).
///
/// Returns a flat `[x0,y0, x1,y1, x2,y2, x3,y3]` array of eight normalised (0..1)
/// coordinates in TL, TR, BR, BL order on success, or an empty array when no confident
/// quad was found — the TS wrapper maps that to `null`, matching the pure-TS detector's
/// return type (`NormalizedCorners | null`) so callers can't tell them apart.
#[wasm_bindgen(js_name = detectSleeveCorners)]
pub fn detect_sleeve_corners(rgba: &[u8], width: u32, height: u32) -> Vec<f64> {
    match detect(rgba, width, height) {
        Some(corners) => corners.iter().flat_map(|&(x, y)| [x, y]).collect(),
        None => Vec::new(),
    }
}

/// Segmentation runs at this longest-side resolution. The morphology radius, the border
/// ring and the thresholds are all set as fractions of the frame, so behaviour is already
/// scale-independent — but a fixed working size keeps a manual "Detect corners" tap fast on
/// a full 2048px capture and stops the connected-component/hull passes scaling with the
/// original megapixels. Corners come back normalised, so the downscale needs no undo.
const WORK_MAX: u32 = 700;

/// The sleeve must cover at least this fraction of the frame — below it the "largest blob"
/// is noise, not a cover.
const MIN_AREA_FRAC: f64 = 0.15;

/// Foreground cutoff, in background-sigmas of the MAD-whitened chroma/luminance distance.
/// ~4σ is the classic outlier boundary; empirically it separates the sleeve on colour,
/// black-and-white and low-contrast captures without letting background grain through.
const K_SIGMA: f32 = 4.0;

/// The blob must fill at least this fraction of its own min-area rectangle. A real sleeve is
/// a filled rectangle (~1.0). This is deliberately loose — a large uniform region of a
/// sleeve (a plain sky, a white border) often doesn't fully segment, so a genuine, correctly
/// placed fit can still be a partial fill; the tilt gate (not this one) is what rejects a
/// blob that isn't the sleeve.
const MIN_RECTANGULARITY: f64 = 0.55;

/// Maximum tilt (degrees of the top edge off horizontal) for an accepted quad. Captures are
/// shot roughly square, so a steep tilt marks a fit onto something other than the sleeve.
const MAX_TILT_DEG: f64 = 12.0;

/// Radius (px at the working resolution) of the edge-preserving median pre-filter that
/// suppresses surface grain before segmentation. Swept against the admin's 308 manual crops:
/// error falls monotonically up to ~3 (median 4.3%→2.7% of the frame, within-5% 167→201),
/// then larger radii start blurring thin/low-contrast sleeves into the background and the
/// accept count drops — so 3 is the knee. 0 disables it.
const SMOOTH_RADIUS: u32 = 3;

/// Optionally dilate the segmented sleeve blob by this fraction of the shorter side before
/// fitting. Left at 0: measured against the true sleeve edge (the midline of the admin's
/// band) a nonzero value didn't reduce corner error, so the plumbing is kept for tuning but
/// disabled by default.
const DILATE_FRAC: f64 = 0.0;

fn detect(rgba: &[u8], width: u32, height: u32) -> Option<Corners> {
    if width < 40 || height < 40 {
        return None;
    }
    let img = ImageRgbaImage::from_raw(width, height, rgba.to_vec())?;
    let work = downscale(&img, WORK_MAX);
    segment(&work)?.accepted
}

/// Downscale so the longest side is at most `max`, preserving aspect; returns the image
/// unchanged when it already fits.
fn downscale(img: &ImageRgbaImage, max: u32) -> ImageRgbaImage {
    let (w, h) = img.dimensions();
    if w.max(h) <= max {
        return img.clone();
    }
    let scale = max as f64 / w.max(h) as f64;
    let nw = ((w as f64 * scale).round() as u32).max(1);
    let nh = ((h as f64 * scale).round() as u32).max(1);
    image::imageops::resize(img, nw, nh, image::imageops::FilterType::Triangle)
}

/// Everything the segmentation produces — the accepted quad plus the intermediate stages,
/// so [`detect`] and the offline harness (`examples/tune.rs`) share one implementation and
/// can't drift.
struct Segmentation {
    #[cfg_attr(not(feature = "debug-harness"), allow(dead_code))]
    background: [u8; 3],
    #[cfg_attr(not(feature = "debug-harness"), allow(dead_code))]
    threshold: u8,
    #[cfg_attr(not(feature = "debug-harness"), allow(dead_code))]
    mask: GrayImage,
    #[cfg_attr(not(feature = "debug-harness"), allow(dead_code))]
    blob_area_frac: f64,
    #[cfg_attr(not(feature = "debug-harness"), allow(dead_code))]
    rectangularity: f64,
    /// The fitted quad in normalised coords whenever a blob was found, regardless of the
    /// accept gates — so the offline harness can measure even a rejected fit against the
    /// admin's manual ground-truth corners.
    #[cfg_attr(not(feature = "debug-harness"), allow(dead_code))]
    quad: Option<Corners>,
    accepted: Option<Corners>,
}

fn segment(src: &ImageRgbaImage) -> Option<Segmentation> {
    let (w, h) = src.dimensions();

    // Edge-preserving median pre-filter. A textured surface (wood grain) inflates the border
    // ring's per-axis std, and since the distance is measured in those sigmas that inflation
    // down-weights the very axis a dark sleeve separates on — luminance — so the sleeve falls
    // under threshold and only its brightest fragments segment. A small median smooths the
    // grain (collapsing that std) while leaving the sleeve↔surface edge intact, so the real
    // separation survives.
    let sr = smooth_radius(w, h);
    let img = if sr > 0 {
        median_filter(src, sr, sr)
    } else {
        src.clone()
    };
    let img = &img;

    // Background colour = median of the frame-border ring. Even a frame-filling sleeve
    // leaves a thin margin, so the ring is majority-background and the median lands on it.
    let ring = (w.min(h) as f64 * 0.04).round().max(3.0) as u32;
    let background = border_median(img, ring);

    // Model the border ring as an axis-aligned Gaussian in YCbCr and measure each pixel's
    // distance from it in background-sigmas per axis (a diagonal Mahalanobis distance). A
    // plain RGB-L1 distance can't separate a low-contrast sleeve: a sky-blue sleeve sits
    // ~37/channel from a tan table, but the table's own grain spreads wider than that, so
    // the sleeve is closer to the background than the background is to itself. Sigma-distance
    // fixes it because the grain is almost all *luminance* noise — stdY is large, so
    // luminance differences are down-weighted — while warm-table-vs-cool-sleeve differ
    // strongly on the chroma axes, where the background's std is small and the difference is
    // amplified. Whichever axis actually separates carries the signal, so this handles the
    // colour, the black-and-white and the low-contrast cases alike.
    let (mean, std) = border_stats(img, ring);
    let mut sigma = vec![0f32; (w * h) as usize];
    let mut dist = GrayImage::new(w, h);
    for (x, y, p) in img.enumerate_pixels() {
        let (yy, cb, cr) = ycbcr(p[0], p[1], p[2]);
        let dy = (yy - mean[0]) / std[0];
        let dcb = (cb - mean[1]) / std[1];
        let dcr = (cr - mean[2]) / std[2];
        let s = (dy * dy + dcb * dcb + dcr * dcr).sqrt();
        sigma[(y * w + x) as usize] = s;
        // A 0..255 view of the sigma field (8σ saturates) purely for the debug harness.
        dist.put_pixel(x, y, Luma([(s * 32.0).min(255.0) as u8]));
    }

    // Threshold in sigma. MAD-whitening puts every capture on the same scale, so a fixed
    // ~4σ outlier cutoff separates the sleeve across colour, black-and-white and low-contrast
    // captures alike (see the crate's test fixtures). An adaptive `ring_p95`-based cutoff was
    // tried and dropped: a grainy, heavy-tailed background pushed it high enough to swallow a
    // genuinely low-contrast sleeve (the Guts case) that a fixed cutoff keeps.
    let k = k_override().unwrap_or(K_SIGMA);
    let threshold = (k * 32.0).min(255.0) as u8;
    let mut mask = GrayImage::new(w, h);
    for (i, &s) in sigma.iter().enumerate() {
        let (x, y) = (i as u32 % w, i as u32 / w);
        mask.put_pixel(x, y, Luma([if s > k { 255 } else { 0 }]));
    }
    // Close interior artwork gaps so the sleeve is one solid blob.
    let close_r = (w.min(h) as f64 * 0.02).round().max(2.0) as u8;
    let mask = close(&mask, Norm::LInf, close_r);

    // Largest connected foreground component = the sleeve.
    let labels = connected_components(&mask, Connectivity::Eight, Luma([0u8]));
    let mut counts: HashMap<u32, u32> = HashMap::new();
    for p in labels.pixels() {
        if p[0] != 0 {
            *counts.entry(p[0]).or_insert(0) += 1;
        }
    }
    let best = counts.iter().max_by_key(|&(_, &c)| c).map(|(&l, _)| l)?;

    // Isolate that component and fill its interior holes. A neutral region printed inside a
    // vivid sleeve (a black-and-white photo inset in Madonna's pink frame) reads as
    // background, leaving the sleeve blob a thin ring; its convex hull is still the whole
    // sleeve, but the ring fills that rectangle so poorly the rectangularity gate would
    // reject a perfectly good cover. Filling holes not open to the frame edge restores the
    // solid sleeve so the gate sees what it actually is.
    let mut comp = GrayImage::new(w, h);
    for (x, y, p) in labels.enumerate_pixels() {
        comp.put_pixel(x, y, Luma([if p[0] == best { 255 } else { 0 }]));
    }
    let comp = fill_holes(&comp);
    // The threshold keeps only *confidently* foreground pixels, so the blob stops a hair
    // inside the true sleeve edge (the anti-aliased boundary pixels fall sub-threshold) —
    // which shows up as a consistent few-percent inward bias against the admin's hand-placed
    // corners. A small dilation pushes the fitted edge back out onto the real boundary.
    let grow = (w.min(h) as f64 * dilate_frac()).round() as u8;
    let comp = if grow > 0 {
        dilate(&comp, Norm::LInf, grow)
    } else {
        comp
    };

    let mut pts: Vec<(f64, f64)> = Vec::new();
    let mut area = 0u32;
    for (x, y, p) in comp.enumerate_pixels() {
        if p[0] != 0 {
            area += 1;
            pts.push((x as f64, y as f64));
        }
    }
    let blob_area_frac = area as f64 / (w * h) as f64;

    let rect = min_area_rect(&convex_hull(&pts));
    let rect_area = quad_area(&rect);
    let rectangularity = if rect_area > 0.0 {
        area as f64 / rect_area
    } else {
        0.0
    };

    let corners = order_corners(rect);
    let norm = normalize(corners, w, h);
    // A record is photographed roughly square to the camera, so a genuine sleeve quad sits
    // near axis-aligned; a steeply tilted fit means the blob wasn't the sleeve (a picture
    // disc or a vivid element on a pale sleeve that the pale sleeve itself didn't separate
    // from its background). Rejecting tilt lets the rectangularity gate run looser without
    // admitting those, which recovers the many good, near-square fits it used to over-reject.
    let tilt = quad_tilt_deg(&norm);
    let accepted = (blob_area_frac >= MIN_AREA_FRAC
        && rectangularity >= min_rectangularity()
        && tilt <= max_tilt_deg()
        && is_plausible(&norm))
    .then_some(norm);

    Some(Segmentation {
        background,
        threshold,
        mask: comp,
        blob_area_frac,
        rectangularity,
        quad: Some(norm),
        accepted,
    })
}

/// Offline tuning harness support (see `examples/tune.rs`). Compiled only under the
/// `debug-harness` feature, never into the shipped wasm. Surfaces the segmentation's
/// intermediate stages so the harness can overlay them on the real capture.
#[cfg(feature = "debug-harness")]
pub mod debug {
    use super::*;

    pub struct DebugReport {
        pub background: [u8; 3],
        pub threshold: u8,
        pub blob_area_frac: f64,
        pub rectangularity: f64,
        /// Foreground mask at the working resolution (255 = foreground).
        pub mask: GrayImage,
        /// The accepted quad in normalised 0..1 coords, if the gates passed — identical to
        /// what the production `detect_sleeve_corners` returns.
        pub accepted: Option<Corners>,
        /// The fitted quad regardless of the accept gates, for measuring near-misses.
        pub quad: Option<Corners>,
    }

    pub fn report(rgba: &[u8], width: u32, height: u32) -> Option<DebugReport> {
        if width < 40 || height < 40 {
            return None;
        }
        let img = ImageRgbaImage::from_raw(width, height, rgba.to_vec())?;
        let work = downscale(&img, WORK_MAX);
        let seg = segment(&work)?;
        Some(DebugReport {
            background: seg.background,
            threshold: seg.threshold,
            blob_area_frac: seg.blob_area_frac,
            rectangularity: seg.rectangularity,
            mask: seg.mask,
            accepted: seg.accepted,
            quad: seg.quad,
        })
    }
}

/// Median RGB of the `ring`-px frame border — a robust background estimate that a few sleeve
/// pixels bleeding into the ring (on a frame-filling cover) can't skew. (Sampling only the
/// frame corners was tried, to dodge the sleeve entirely on frame-filling covers, but these
/// covers are framed to fill the frame so the sleeve reaches the corners too — it collapsed
/// the accept rate; the whole-ring median is what survives.)
fn border_median(img: &ImageRgbaImage, ring: u32) -> [u8; 3] {
    let (w, h) = img.dimensions();
    let mut ch: [Vec<u8>; 3] = [Vec::new(), Vec::new(), Vec::new()];
    for (x, y, p) in img.enumerate_pixels() {
        if x < ring || y < ring || x >= w - ring || y >= h - ring {
            for (c, v) in ch.iter_mut().enumerate() {
                v.push(p[c]);
            }
        }
    }
    let mut out = [0u8; 3];
    for (c, v) in ch.iter_mut().enumerate() {
        v.sort_unstable();
        out[c] = v.get(v.len() / 2).copied().unwrap_or(0);
    }
    out
}

/// Tilt (degrees off horizontal) of a quad's top edge. Captures are square, so normalised
/// coords preserve the angle.
fn quad_tilt_deg(c: &Corners) -> f64 {
    let (dx, dy) = (c[1].0 - c[0].0, c[1].1 - c[0].1);
    dy.atan2(dx).to_degrees().abs()
}

/// Overrides for offline sweeps (env vars); always the compiled constant in the shipped wasm.
#[cfg(feature = "debug-harness")]
fn env_f<T: std::str::FromStr>(name: &str, default: T) -> T {
    std::env::var(name).ok().and_then(|v| v.parse().ok()).unwrap_or(default)
}
#[cfg(feature = "debug-harness")]
fn k_override() -> Option<f32> {
    std::env::var("K_SIGMA").ok().and_then(|v| v.parse().ok())
}
#[cfg(feature = "debug-harness")]
fn min_rectangularity() -> f64 {
    env_f("MIN_RECT", MIN_RECTANGULARITY)
}
#[cfg(feature = "debug-harness")]
fn max_tilt_deg() -> f64 {
    env_f("MAX_TILT", MAX_TILT_DEG)
}
#[cfg(feature = "debug-harness")]
fn dilate_frac() -> f64 {
    env_f("DILATE_FRAC", DILATE_FRAC)
}
#[cfg(feature = "debug-harness")]
fn smooth_radius(_w: u32, _h: u32) -> u32 {
    env_f("SMOOTH_R", SMOOTH_RADIUS)
}
#[cfg(not(feature = "debug-harness"))]
fn k_override() -> Option<f32> {
    None
}
#[cfg(not(feature = "debug-harness"))]
fn min_rectangularity() -> f64 {
    MIN_RECTANGULARITY
}
#[cfg(not(feature = "debug-harness"))]
fn max_tilt_deg() -> f64 {
    MAX_TILT_DEG
}
#[cfg(not(feature = "debug-harness"))]
fn dilate_frac() -> f64 {
    DILATE_FRAC
}
#[cfg(not(feature = "debug-harness"))]
fn smooth_radius(_w: u32, _h: u32) -> u32 {
    SMOOTH_RADIUS
}

/// ITU-R BT.601 YCbCr — a cheap luminance/chroma opponent split. Luminance (Y) carries the
/// grain; the chroma axes (Cb, Cr) carry the warm/cool separation a low-contrast sleeve
/// hides in.
fn ycbcr(r: u8, g: u8, b: u8) -> (f32, f32, f32) {
    let (r, g, b) = (r as f32, g as f32, b as f32);
    let y = 0.299 * r + 0.587 * g + 0.114 * b;
    let cb = -0.168736 * r - 0.331264 * g + 0.5 * b + 128.0;
    let cr = 0.5 * r - 0.418688 * g - 0.081312 * b + 128.0;
    (y, cb, cr)
}

/// Per-axis centre and spread of the border ring in YCbCr — the background Gaussian the
/// sigma-distance is measured against. Uses the **median** and **MAD** (median absolute
/// deviation, rescaled to a std) rather than mean/std because a frame-filling sleeve pushes
/// its own pixels into the ring: a mean/std there is dragged toward the sleeve and inflates
/// the spread until nothing clears the threshold, whereas the median/MAD shrug off up to
/// ~half the ring being sleeve. Each std is floored so a channel that's uniform across the
/// ring (e.g. Cb of a neutral-grey background) doesn't turn sensor noise into a huge sigma;
/// the floor is roughly JPEG/sensor chroma noise.
fn border_stats(img: &ImageRgbaImage, ring: u32) -> ([f32; 3], [f32; 3]) {
    let (w, h) = img.dimensions();
    let mut ch: [Vec<f32>; 3] = [Vec::new(), Vec::new(), Vec::new()];
    for (x, y, p) in img.enumerate_pixels() {
        if x < ring || y < ring || x >= w - ring || y >= h - ring {
            let (yy, cb, cr) = ycbcr(p[0], p[1], p[2]);
            ch[0].push(yy);
            ch[1].push(cb);
            ch[2].push(cr);
        }
    }
    let median = |v: &mut [f32]| -> f32 {
        if v.is_empty() {
            return 0.0;
        }
        v.sort_by(|a, b| a.partial_cmp(b).unwrap());
        v[v.len() / 2]
    };
    let mut mean = [0f32; 3];
    let mut std = [3f32; 3];
    for c in 0..3 {
        let m = median(&mut ch[c]);
        mean[c] = m;
        let mut dev: Vec<f32> = ch[c].iter().map(|&v| (v - m).abs()).collect();
        // 1.4826 * MAD ≈ σ for a Gaussian.
        std[c] = (1.4826 * median(&mut dev)).max(3.0);
    }
    (mean, std)
}

/// 95th-percentile sigma-distance among the border-ring pixels — the ceiling of the
/// background's own noise (in its own sigmas), used to place the threshold just above it.
fn ring_sigma_p95(sigma: &[f32], w: u32, h: u32, ring: u32) -> f32 {
    let mut vals: Vec<f32> = Vec::new();
    for y in 0..h {
        for x in 0..w {
            if x < ring || y < ring || x >= w - ring || y >= h - ring {
                vals.push(sigma[(y * w + x) as usize]);
            }
        }
    }
    if vals.is_empty() {
        return 0.0;
    }
    vals.sort_by(|a, b| a.partial_cmp(b).unwrap());
    vals[((vals.len() as f64 * 0.95) as usize).min(vals.len() - 1)]
}

/// Fill interior holes of a binary component (255 = foreground). A "hole" is a background
/// region not connected to the image border: label the background with 4-connectivity (the
/// dual of the foreground's 8-connectivity, so a diagonal pixel bridge can't let a hole
/// "leak" to the border), mark every label that touches the frame edge as truly outside,
/// and promote the rest to foreground.
fn fill_holes(comp: &GrayImage) -> GrayImage {
    let (w, h) = comp.dimensions();
    let mut inv = GrayImage::new(w, h);
    for (x, y, p) in comp.enumerate_pixels() {
        inv.put_pixel(x, y, Luma([if p[0] == 0 { 255 } else { 0 }]));
    }
    let labels = connected_components(&inv, Connectivity::Four, Luma([0u8]));
    let mut border: HashSet<u32> = HashSet::new();
    for x in 0..w {
        border.insert(labels.get_pixel(x, 0)[0]);
        border.insert(labels.get_pixel(x, h - 1)[0]);
    }
    for y in 0..h {
        border.insert(labels.get_pixel(0, y)[0]);
        border.insert(labels.get_pixel(w - 1, y)[0]);
    }
    let mut out = comp.clone();
    for (x, y, p) in labels.enumerate_pixels() {
        if p[0] != 0 && !border.contains(&p[0]) {
            out.put_pixel(x, y, Luma([255]));
        }
    }
    out
}

/// Andrew's monotone chain — convex hull of the blob, CCW.
fn convex_hull(pts: &[(f64, f64)]) -> Vec<(f64, f64)> {
    let mut p = pts.to_vec();
    p.sort_by(|a, b| a.partial_cmp(b).unwrap());
    p.dedup();
    if p.len() < 3 {
        return p;
    }
    let cross = |o: (f64, f64), a: (f64, f64), b: (f64, f64)| {
        (a.0 - o.0) * (b.1 - o.1) - (a.1 - o.1) * (b.0 - o.0)
    };
    let mut lower: Vec<(f64, f64)> = Vec::new();
    for &pt in &p {
        while lower.len() >= 2 && cross(lower[lower.len() - 2], lower[lower.len() - 1], pt) <= 0.0
        {
            lower.pop();
        }
        lower.push(pt);
    }
    let mut upper: Vec<(f64, f64)> = Vec::new();
    for &pt in p.iter().rev() {
        while upper.len() >= 2 && cross(upper[upper.len() - 2], upper[upper.len() - 1], pt) <= 0.0
        {
            upper.pop();
        }
        upper.push(pt);
    }
    lower.pop();
    upper.pop();
    lower.extend(upper);
    lower
}

/// Minimum-area enclosing rectangle via rotating calipers (brute force over hull edges —
/// the min-area rect always has one side flush with a hull edge). Returns four corners.
fn min_area_rect(hull: &[(f64, f64)]) -> [(f64, f64); 4] {
    if hull.len() < 3 {
        let (mut mn, mut mx) = ((f64::MAX, f64::MAX), (f64::MIN, f64::MIN));
        for &(x, y) in hull {
            mn.0 = mn.0.min(x);
            mn.1 = mn.1.min(y);
            mx.0 = mx.0.max(x);
            mx.1 = mx.1.max(y);
        }
        return [(mn.0, mn.1), (mx.0, mn.1), (mx.0, mx.1), (mn.0, mx.1)];
    }
    let n = hull.len();
    let mut best_area = f64::MAX;
    let mut best = [(0.0, 0.0); 4];
    for i in 0..n {
        let a = hull[i];
        let b = hull[(i + 1) % n];
        let (mut ex, mut ey) = (b.0 - a.0, b.1 - a.1);
        let len = (ex * ex + ey * ey).sqrt();
        if len < 1e-9 {
            continue;
        }
        ex /= len;
        ey /= len;
        // Edge axis u = (ex,ey), normal v = (-ey,ex).
        let (mut umin, mut umax, mut vmin, mut vmax) = (f64::MAX, f64::MIN, f64::MAX, f64::MIN);
        for &(x, y) in hull {
            let u = x * ex + y * ey;
            let v = -x * ey + y * ex;
            umin = umin.min(u);
            umax = umax.max(u);
            vmin = vmin.min(v);
            vmax = vmax.max(v);
        }
        let area = (umax - umin) * (vmax - vmin);
        if area < best_area {
            best_area = area;
            // Reconstruct corners: p = u*(ex,ey) + v*(-ey,ex).
            let corner = |u: f64, v: f64| (u * ex - v * ey, u * ey + v * ex);
            best = [
                corner(umin, vmin),
                corner(umax, vmin),
                corner(umax, vmax),
                corner(umin, vmax),
            ];
        }
    }
    best
}

/// Shoelace area of a 4-point polygon.
fn quad_area(q: &[(f64, f64); 4]) -> f64 {
    let mut a = 0.0;
    for i in 0..4 {
        let (x0, y0) = q[i];
        let (x1, y1) = q[(i + 1) % 4];
        a += x0 * y1 - x1 * y0;
    }
    (a / 2.0).abs()
}

/// Sort any four points into TL, TR, BR, BL order — the same rule as the TS side's
/// `orderCorners` (top two by y, split by x; then bottom two by y, split by x), so a
/// rectangle fitted in any orientation still lands in the order every downstream consumer
/// (the warp, the corner editor) expects.
fn order_corners(mut p: [(f64, f64); 4]) -> Corners {
    p.sort_by(|a, b| a.1.partial_cmp(&b.1).unwrap());
    let mut top = [p[0], p[1]];
    let mut bottom = [p[2], p[3]];
    top.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap());
    bottom.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap());
    [top[0], top[1], bottom[1], bottom[0]]
}

fn normalize(corners: Corners, width: u32, height: u32) -> Corners {
    let w = (width - 1).max(1) as f64;
    let h = (height - 1).max(1) as f64;
    let clamp01 = |v: f64| v.clamp(0.0, 1.0);
    let mut out = [(0.0, 0.0); 4];
    for (i, &(x, y)) in corners.iter().enumerate() {
        out[i] = (clamp01(x / w), clamp01(y / h));
    }
    out
}

/// Reject an implausible quad — collapsed onto too small a region, or with corners out of
/// clockwise order — the same guard the TS detector applies to its own fit. (Degeneracy is
/// already impossible here: a min-area rectangle is convex by construction.)
fn is_plausible(c: &Corners) -> bool {
    let xs: Vec<f64> = c.iter().map(|p| p.0).collect();
    let ys: Vec<f64> = c.iter().map(|p| p.1).collect();
    let (min_x, max_x) = (
        xs.iter().cloned().fold(f64::MAX, f64::min),
        xs.iter().cloned().fold(f64::MIN, f64::max),
    );
    let (min_y, max_y) = (
        ys.iter().cloned().fold(f64::MAX, f64::min),
        ys.iter().cloned().fold(f64::MIN, f64::max),
    );
    if max_x - min_x < 0.4 || max_y - min_y < 0.4 {
        return false;
    }
    let (tl, tr, br, bl) = (c[0], c[1], c[2], c[3]);
    if tl.0 >= tr.0 || bl.0 >= br.0 {
        return false;
    }
    if tl.1 >= bl.1 || tr.1 >= br.1 {
        return false;
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Rasterise a filled quad (any winding) onto an RGBA buffer via a point-in-polygon
    /// test — good enough for a synthetic test fixture, no need for a real photo.
    fn draw_quad(
        buf: &mut [u8],
        width: u32,
        height: u32,
        quad: [(f64, f64); 4],
        rgb: (u8, u8, u8),
    ) {
        let inside = |x: f64, y: f64| -> bool {
            let mut sign = 0i32;
            for i in 0..4 {
                let (ax, ay) = quad[i];
                let (bx, by) = quad[(i + 1) % 4];
                let cross = (bx - ax) * (y - ay) - (by - ay) * (x - ax);
                if cross == 0.0 {
                    continue;
                }
                let s = if cross > 0.0 { 1 } else { -1 };
                if sign == 0 {
                    sign = s;
                } else if s != sign {
                    return false;
                }
            }
            true
        };
        for y in 0..height {
            for x in 0..width {
                if inside(x as f64 + 0.5, y as f64 + 0.5) {
                    let i = ((y * width + x) * 4) as usize;
                    buf[i] = rgb.0;
                    buf[i + 1] = rgb.1;
                    buf[i + 2] = rgb.2;
                    buf[i + 3] = 255;
                }
            }
        }
    }

    fn fill_bg(buf: &mut [u8], rgb: (u8, u8, u8)) {
        for px in buf.chunks_exact_mut(4) {
            px[0] = rgb.0;
            px[1] = rgb.1;
            px[2] = rgb.2;
            px[3] = 255;
        }
    }

    fn corners_of(flat: &[f64]) -> Corners {
        [
            (flat[0], flat[1]),
            (flat[2], flat[3]),
            (flat[4], flat[5]),
            (flat[6], flat[7]),
        ]
    }

    fn assert_close(got: Corners, expected: Corners, tol: f64) {
        for i in 0..4 {
            assert!(
                (got[i].0 - expected[i].0).abs() < tol,
                "corner {i} x off: got {:?} expected {:?}",
                got[i],
                expected[i]
            );
            assert!(
                (got[i].1 - expected[i].1).abs() < tol,
                "corner {i} y off: got {:?} expected {:?}",
                got[i],
                expected[i]
            );
        }
    }

    /// Mirrors the case that broke the old TS band-scan: a sleeve that does NOT fill the
    /// frame and sits on a moderate- rather than high-contrast background — a tan cover on a
    /// tan wall.
    #[test]
    fn finds_a_sleeve_that_does_not_fill_the_frame() {
        let (w, h) = (600u32, 600u32);
        let mut buf = vec![0u8; (w * h * 4) as usize];
        fill_bg(&mut buf, (200, 180, 140));
        let quad = [(150.0, 90.0), (480.0, 130.0), (450.0, 500.0), (120.0, 460.0)];
        draw_quad(&mut buf, w, h, quad, (165, 135, 90));

        let result = detect_sleeve_corners(&buf, w, h);
        assert_eq!(result.len(), 8, "expected a confident quad, got {result:?}");
        let expected = normalize(
            order_corners(quad),
            w,
            h,
        );
        // Generous tolerance: downscale + segmentation + rect fit shift the fitted quad a
        // few px from the drawn one; we only care it lands in the right place.
        assert_close(corners_of(&result), expected, 0.04);
    }

    /// The Guts case in miniature: a *cool* sleeve on a *warm* background whose RGB-L1
    /// distance (~37/channel) is smaller than the kind of grain a real background carries,
    /// so a brightness/RGB threshold can't separate them — but the two are far apart on the
    /// chroma axes, which is exactly what the whitened YCbCr distance keys on. Guards against
    /// a regression back to an RGB-only distance.
    #[test]
    fn finds_a_low_contrast_cool_sleeve_on_a_warm_background() {
        let (w, h) = (600u32, 600u32);
        let mut buf = vec![0u8; (w * h * 4) as usize];
        fill_bg(&mut buf, (200, 180, 140)); // warm tan
        let quad = [(150.0, 90.0), (470.0, 120.0), (450.0, 500.0), (120.0, 470.0)];
        draw_quad(&mut buf, w, h, quad, (150, 165, 185)); // cool blue-grey, ~37/ch in RGB
        let result = detect_sleeve_corners(&buf, w, h);
        assert_eq!(result.len(), 8, "expected a confident quad, got {result:?}");
        let expected = normalize(order_corners(quad), w, h);
        assert_close(corners_of(&result), expected, 0.04);
    }

    /// The easy, common case: a high-contrast sleeve that nearly fills the frame.
    #[test]
    fn finds_a_high_contrast_sleeve_that_fills_the_frame() {
        let (w, h) = (500u32, 500u32);
        let mut buf = vec![0u8; (w * h * 4) as usize];
        fill_bg(&mut buf, (20, 20, 20));
        let quad = [(20.0, 15.0), (480.0, 25.0), (475.0, 490.0), (15.0, 480.0)];
        draw_quad(&mut buf, w, h, quad, (235, 235, 230));

        let result = detect_sleeve_corners(&buf, w, h);
        assert_eq!(result.len(), 8, "expected a confident quad, got {result:?}");
        let expected = normalize(order_corners(quad), w, h);
        assert_close(corners_of(&result), expected, 0.05);
    }

    /// A non-rectangular foreground blob (a filled triangle) must be rejected by the
    /// rectangularity gate — it fills its own min-area rectangle only ~half way. This is the
    /// Guts-style failure in miniature: a high-contrast shape that isn't the sleeve.
    #[test]
    fn rejects_a_non_rectangular_blob() {
        let (w, h) = (500u32, 500u32);
        let mut buf = vec![0u8; (w * h * 4) as usize];
        fill_bg(&mut buf, (20, 20, 20));
        // A big triangle (degenerate 4th point duplicated) filling much of the frame.
        let tri = [(250.0, 40.0), (250.0, 40.0), (460.0, 460.0), (40.0, 460.0)];
        draw_quad(&mut buf, w, h, tri, (235, 235, 230));

        assert!(
            detect_sleeve_corners(&buf, w, h).is_empty(),
            "a triangular blob should fail the rectangularity gate"
        );
    }

    #[test]
    fn returns_empty_for_a_blank_image() {
        let (w, h) = (200u32, 200u32);
        let buf = vec![128u8; (w * h * 4) as usize];
        assert!(detect_sleeve_corners(&buf, w, h).is_empty());
    }

    #[test]
    fn returns_empty_for_too_small_an_image() {
        let buf = vec![255u8; 10 * 10 * 4];
        assert!(detect_sleeve_corners(&buf, 10, 10).is_empty());
    }
}
