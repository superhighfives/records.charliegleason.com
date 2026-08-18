//! Whole-frame sleeve-corner detection: a Canny + contour based replacement for the
//! narrow-band luminance scan in `src/lib/photo-processing.ts`'s `detectSleeveCorners`.
//! Unlike that scan (which only looks within 18% of the frame edge on each side, so it
//! misses a sleeve that doesn't nearly fill the frame), this searches the whole image for
//! the largest quadrilateral-ish contour, so it isn't tied to how tightly the sleeve was
//! framed in the capture.
//!
//! Mirrors the TS side's conventions exactly so the two are interchangeable: input is a
//! plain RGBA buffer (`RgbaImage` on the TS side), output is four [x, y] corners in
//! TL, TR, BR, BL order, normalised to 0..1 of the image, or nothing if no confident quad
//! is found.

use image::{GrayImage, RgbaImage as ImageRgbaImage};
use imageproc::contours::{BorderType, find_contours};
use imageproc::distance_transform::Norm;
use imageproc::edges::canny;
use imageproc::geometry::approximate_polygon_dp;
use imageproc::gradients::sobel_gradients;
use imageproc::morphology::dilate;
use imageproc::point::Point;
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

fn detect(rgba: &[u8], width: u32, height: u32) -> Option<Corners> {
    if width < 40 || height < 40 {
        return None;
    }
    let img = ImageRgbaImage::from_raw(width, height, rgba.to_vec())?;
    let gray = image::imageops::grayscale(&img);

    // Contour tracing treats the image boundary specially, which visibly nudges a corner
    // that sits right at (or past, once dilated) the original frame edge — exactly the
    // "sleeve fills the frame" case the old detector already handled well. Working on a
    // version padded with replicated edge pixels moves the true image boundary away from
    // any real sleeve edge, so tracing always sees it as an ordinary interior edge; `PAD`
    // is subtracted back out before normalising.
    const PAD: i32 = 16;
    let gray = pad_replicate(&gray, PAD as u32);

    // `canny` does its own internal Gaussian blur (fixed sigma 1.4) before taking Sobel
    // gradients, so this measures thresholds on the same un-blurred input it receives —
    // pre-blurring here would stack a second blur on top of canny's and wash out exactly
    // the moderate-contrast edges (a tan sleeve on a tan wall) whole-frame detection is
    // supposed to catch that the old narrow-band scan couldn't.
    let (low, high) = auto_canny_thresholds(&gray);
    let edges = canny(&gray, low, high);
    // Canny leaves 1px gaps at weak junctions; a 2px dilation closes them so the sleeve's
    // border forms one closed loop for `find_contours` instead of several open arcs.
    let closed = dilate(&edges, Norm::LInf, 2);

    let contours = find_contours::<i32>(&closed);
    let image_area = (width as f64) * (height as f64);

    // Consider only outer (not hole) contours enclosing a meaningful chunk of the frame —
    // drops both noise specks and internal artwork edges, which are always smaller than
    // the sleeve's own outline since they sit inside it.
    let mut candidates: Vec<Vec<Point<i32>>> = contours
        .into_iter()
        .filter(|c| c.border_type == BorderType::Outer)
        .map(|c| c.points)
        .filter(|pts| polygon_area(pts) / image_area > 0.15)
        .collect();
    candidates.sort_by(|a, b| polygon_area(b).partial_cmp(&polygon_area(a)).unwrap());

    for pts in &candidates {
        if let Some(quad) = quadify(pts) {
            let unpadded = quad.map(|p| Point::new(p.x - PAD, p.y - PAD));
            let corners = order_corners(unpadded);
            let norm = normalize(corners, width, height);
            if is_plausible(&norm) {
                return Some(norm);
            }
        }
    }
    None
}

/// Grow `gray` by `pad` pixels on every side, replicating the edge pixel outward — an
/// edge-replicated border adds no new gradient of its own (a flat extension of whatever
/// was already at the boundary), so it can't spuriously attract Canny/contour tracing.
fn pad_replicate(gray: &GrayImage, pad: u32) -> GrayImage {
    let (w, h) = gray.dimensions();
    let pad_i = pad as i32;
    GrayImage::from_fn(w + 2 * pad, h + 2 * pad, |x, y| {
        let sx = (x as i32 - pad_i).clamp(0, w as i32 - 1) as u32;
        let sy = (y as i32 - pad_i).clamp(0, h as i32 - 1) as u32;
        *gray.get_pixel(sx, sy)
    })
}

/// Percentile-based thresholds on the *actual* Sobel gradient-magnitude distribution
/// (`canny`'s edge "strength" is `sqrt(dx^2 + dy^2)` from the same Sobel kernels
/// `sobel_gradients` uses — see its doc comment), not on pixel intensity — a fixed
/// intensity-based guess (à la the common "auto Canny" recipe) lives on the wrong scale
/// entirely (intensity 0..255 vs. gradient strength 0..~1140) and silently drops every
/// edge on a low-contrast capture. The sleeve's border is a long, straight, unbroken edge,
/// so it dominates the *upper* tail of the gradient histogram even when its contrast
/// against the background is modest — a `high` percentile finds it regardless of the
/// image's overall brightness or contrast; `low` just lets hysteresis follow that same
/// border across a locally weaker or slightly blurred stretch.
fn auto_canny_thresholds(gray: &GrayImage) -> (f32, f32) {
    let grad = sobel_gradients(gray);
    let mut mags: Vec<u16> = grad.pixels().map(|p| p.0[0]).collect();
    if mags.is_empty() {
        return (20.0, 60.0);
    }
    mags.sort_unstable();
    let percentile = |p: f64| -> f32 {
        let idx = (((mags.len() - 1) as f64) * p).round() as usize;
        mags[idx] as f32
    };
    let high = percentile(0.92).max(20.0);
    let low = (high * 0.4).max(10.0);
    (low, high)
}

/// Shoelace formula; contour points are already in a consistent winding order.
fn polygon_area(pts: &[Point<i32>]) -> f64 {
    if pts.len() < 3 {
        return 0.0;
    }
    let mut area = 0.0;
    for i in 0..pts.len() {
        let a = pts[i];
        let b = pts[(i + 1) % pts.len()];
        area += (a.x as f64) * (b.y as f64) - (b.x as f64) * (a.y as f64);
    }
    (area / 2.0).abs()
}

fn arc_length(pts: &[Point<i32>]) -> f64 {
    let mut len = 0.0;
    for i in 0..pts.len() {
        let a = pts[i];
        let b = pts[(i + 1) % pts.len()];
        len += (((a.x - b.x).pow(2) + (a.y - b.y).pow(2)) as f64).sqrt();
    }
    len
}

/// Reduce a noisy contour to a quadrilateral, the same way OpenCV-based document
/// scanners do: Douglas-Peucker with an epsilon proportional to the contour's own arc
/// length, so it adapts to the sleeve's size in frame rather than a fixed pixel radius.
/// Widens the epsilon a few times if the first pass doesn't land on exactly 4 points —
/// a real sleeve edge always simplifies to a quad *somewhere* in that range; a shape that
/// never does isn't the sleeve.
fn quadify(pts: &[Point<i32>]) -> Option<[Point<i32>; 4]> {
    let perim = arc_length(pts);
    if perim <= 0.0 {
        return None;
    }
    for frac in [0.02, 0.035, 0.05, 0.08] {
        let approx = approximate_polygon_dp(pts, perim * frac, true);
        if approx.len() == 4 {
            return Some([approx[0], approx[1], approx[2], approx[3]]);
        }
    }
    None
}

/// Sort any four points into TL, TR, BR, BL order — the same rule as the TS side's
/// `orderCorners` (top two by y, split by x; then bottom two by y, split by x), so a
/// contour walked in any winding direction still lands in the order every downstream
/// consumer (the warp, the corner editor) expects.
fn order_corners(pts: [Point<i32>; 4]) -> [(f64, f64); 4] {
    let mut by_y = pts;
    by_y.sort_by_key(|p| p.y);
    let mut top = [by_y[0], by_y[1]];
    let mut bottom = [by_y[2], by_y[3]];
    top.sort_by_key(|p| p.x);
    bottom.sort_by_key(|p| p.x);
    [
        (top[0].x as f64, top[0].y as f64),
        (top[1].x as f64, top[1].y as f64),
        (bottom[1].x as f64, bottom[1].y as f64),
        (bottom[0].x as f64, bottom[0].y as f64),
    ]
}

fn normalize(corners: [(f64, f64); 4], width: u32, height: u32) -> Corners {
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
/// clockwise order — the same guard the TS detector applies to its own fit.
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

    /// Mirrors the case that broke the old TS band-scan: a sleeve that does NOT fill the
    /// frame (well outside the old 18%-inward search band on every side) and sits on a
    /// moderate- rather than high-contrast background — a tan cover on a tan wall.
    fn undersized_low_contrast_fixture() -> (Vec<u8>, u32, u32, [(f64, f64); 4]) {
        let (w, h) = (600u32, 600u32);
        let mut buf = vec![0u8; (w * h * 4) as usize];
        // Background: dull tan wall.
        for i in 0..(w * h) as usize {
            buf[i * 4] = 200;
            buf[i * 4 + 1] = 180;
            buf[i * 4 + 2] = 140;
            buf[i * 4 + 3] = 255;
        }
        // Sleeve: a mildly rotated quad occupying the middle ~55% of the frame (well past
        // the old 18% band on every side) in a close but distinguishable tan.
        let quad = [
            (150.0, 90.0),
            (480.0, 130.0),
            (450.0, 500.0),
            (120.0, 460.0),
        ];
        draw_quad(&mut buf, w, h, quad, (165, 135, 90));
        (buf, w, h, quad)
    }

    #[test]
    fn finds_a_sleeve_that_does_not_fill_the_frame() {
        let (buf, w, h, expected) = undersized_low_contrast_fixture();
        let result = detect_sleeve_corners(&buf, w, h);
        assert_eq!(result.len(), 8, "expected a confident quad, got {result:?}");

        let got: Corners = [
            (result[0], result[1]),
            (result[2], result[3]),
            (result[4], result[5]),
            (result[6], result[7]),
        ];
        let expected_norm = normalize(
            order_corners(expected.map(|(x, y)| Point::new(x as i32, y as i32))),
            w,
            h,
        );

        // A generous tolerance: dilation/DP-approximation shift the fitted quad a few
        // pixels from the drawn one, we only care that it's in the right place.
        for i in 0..4 {
            assert!(
                (got[i].0 - expected_norm[i].0).abs() < 0.03,
                "corner {i} x off: got {:?} expected {:?}",
                got[i],
                expected_norm[i]
            );
            assert!(
                (got[i].1 - expected_norm[i].1).abs() < 0.03,
                "corner {i} y off: got {:?} expected {:?}",
                got[i],
                expected_norm[i]
            );
        }
    }

    /// The easy, common case: a sleeve that nearly fills the frame at high contrast —
    /// exactly what the old TS band-scan already handled. Guards against a change that
    /// fixes the low-contrast/undersized case while regressing the common one.
    #[test]
    fn finds_a_high_contrast_sleeve_that_fills_the_frame() {
        let (w, h) = (500u32, 500u32);
        let mut buf = vec![0u8; (w * h * 4) as usize];
        for i in 0..(w * h) as usize {
            buf[i * 4] = 20;
            buf[i * 4 + 1] = 20;
            buf[i * 4 + 2] = 20;
            buf[i * 4 + 3] = 255;
        }
        let quad = [(20.0, 15.0), (480.0, 25.0), (475.0, 490.0), (15.0, 480.0)];
        draw_quad(&mut buf, w, h, quad, (235, 235, 230));

        let result = detect_sleeve_corners(&buf, w, h);
        assert_eq!(result.len(), 8, "expected a confident quad, got {result:?}");
        let got: Corners = [
            (result[0], result[1]),
            (result[2], result[3]),
            (result[4], result[5]),
            (result[6], result[7]),
        ];
        let expected_norm = normalize(
            order_corners(quad.map(|(x, y)| Point::new(x as i32, y as i32))),
            w,
            h,
        );
        // Looser than the other fixture's tolerance: Canny + contour + Douglas-Peucker
        // approximation can bevel a corner by a few percent (dilation rounds it, then DP
        // simplification cuts across the rounding) in a way a direct per-edge line fit
        // wouldn't — acceptable because this is only ever a seed for the corner editor,
        // sharpened afterwards by `refineQuadEdgesDetailed` on the TS side.
        for i in 0..4 {
            assert!(
                (got[i].0 - expected_norm[i].0).abs() < 0.06,
                "corner {i} x off: got {:?} expected {:?}",
                got[i],
                expected_norm[i]
            );
            assert!(
                (got[i].1 - expected_norm[i].1).abs() < 0.06,
                "corner {i} y off: got {:?} expected {:?}",
                got[i],
                expected_norm[i]
            );
        }
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
