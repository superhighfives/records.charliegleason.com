//! Offline tuning harness for the sleeve-corner detector — NOT shipped (gated behind the
//! `debug-harness` feature). Decodes real capture files, runs the exact production
//! segmentation via `sleeve_detect::debug::report`, prints the background estimate /
//! threshold / blob area / rectangularity, and writes:
//!   <name>.detected.png — the accepted quad (green) overlaid on the photo, or the photo
//!                         untouched when the detector bailed
//!   <name>.mask.png     — the foreground mask, so a miss is diagnosable at a glance
//!
//! Run: cargo run --example tune --features debug-harness -- <img1.webp> <img2.webp> ...

use image::{GenericImageView, Rgba, RgbaImage};
use sleeve_detect::debug;
use std::path::Path;

fn main() {
    let paths: Vec<String> = std::env::args().skip(1).collect();
    if paths.is_empty() {
        eprintln!("usage: tune <image> [image ...]");
        std::process::exit(2);
    }
    for path in &paths {
        if let Err(e) = run_one(path) {
            eprintln!("{path}: {e}");
        }
    }
}

fn run_one(path: &str) -> Result<(), String> {
    let dyn_img = image::open(path).map_err(|e| e.to_string())?;
    let (w, h) = dyn_img.dimensions();
    let mut rgba = dyn_img.to_rgba8();
    let report = debug::report(rgba.as_raw(), w, h)
        .ok_or_else(|| "image too small / undecodable".to_string())?;

    println!("\n=== {path}  ({w}x{h}) ===");
    println!(
        "  bg=rgb({},{},{})  threshold={}  blob={:.2}  rectangularity={:.2}",
        report.background[0],
        report.background[1],
        report.background[2],
        report.threshold,
        report.blob_area_frac,
        report.rectangularity,
    );
    match report.accepted {
        Some(q) => {
            println!(
                "  -> ACCEPT [{}]",
                q.iter()
                    .map(|(x, y)| format!("({:.3},{:.3})", x, y))
                    .collect::<Vec<_>>()
                    .join(" ")
            );
            let px: [(f64, f64); 4] =
                q.map(|(x, y)| (x * (w - 1) as f64, y * (h - 1) as f64));
            draw_quad(&mut rgba, &px, Rgba([40, 220, 60, 255]), 4);
        }
        None => println!("  -> REJECT (button would show 'couldn't find')"),
    }

    // Machine-readable line for the ground-truth comparison harness: accepted flag then the
    // fitted quad (present even on a reject, so a near-miss is measurable).
    let flat = report
        .quad
        .map(|q| {
            q.iter()
                .flat_map(|&(x, y)| [x, y])
                .map(|v| format!("{v:.4}"))
                .collect::<Vec<_>>()
                .join(",")
        })
        .unwrap_or_else(|| "-".into());
    println!(
        "RESULT\t{}\t{}",
        if report.accepted.is_some() { 1 } else { 0 },
        flat
    );

    let stem = Path::new(path)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("out");
    let dir = Path::new(path).parent().unwrap_or_else(|| Path::new("."));
    rgba.save(dir.join(format!("{stem}.detected.png")))
        .map_err(|e| e.to_string())?;
    report
        .mask
        .save(dir.join(format!("{stem}.mask.png")))
        .map_err(|e| e.to_string())?;
    println!("  wrote {stem}.detected.png and {stem}.mask.png");
    Ok(())
}

/// Bresenham line, thickened by stamping a `thick`-radius square at each step — keeps the
/// example free of any imageproc drawing feature.
fn draw_quad(img: &mut RgbaImage, quad: &[(f64, f64); 4], color: Rgba<u8>, thick: i32) {
    for i in 0..4 {
        let (x0, y0) = quad[i];
        let (x1, y1) = quad[(i + 1) % 4];
        draw_line(img, x0, y0, x1, y1, color, thick);
    }
}

fn draw_line(img: &mut RgbaImage, x0: f64, y0: f64, x1: f64, y1: f64, c: Rgba<u8>, t: i32) {
    let (mut x0, mut y0) = (x0.round() as i32, y0.round() as i32);
    let (x1, y1) = (x1.round() as i32, y1.round() as i32);
    let dx = (x1 - x0).abs();
    let dy = -(y1 - y0).abs();
    let sx = if x0 < x1 { 1 } else { -1 };
    let sy = if y0 < y1 { 1 } else { -1 };
    let mut err = dx + dy;
    let (iw, ih) = (img.width() as i32, img.height() as i32);
    loop {
        for oy in -t..=t {
            for ox in -t..=t {
                let (px, py) = (x0 + ox, y0 + oy);
                if px >= 0 && py >= 0 && px < iw && py < ih {
                    img.put_pixel(px as u32, py as u32, c);
                }
            }
        }
        if x0 == x1 && y0 == y1 {
            break;
        }
        let e2 = 2 * err;
        if e2 >= dy {
            err += dy;
            x0 += sx;
        }
        if e2 <= dx {
            err += dx;
            y0 += sy;
        }
    }
}
