#!/usr/bin/env node
// Generate public/og-image.png in the site's editorial style:
// the badge (public/logo512.png) on the left, then a gold "THE COLLECTION"
// eyebrow, a Fraunces "Records" wordmark, and a gray "<domain>" line.
//
// Fonts: the wordmark uses Fraunces (same as the site); it's downloaded once and
// cached under scripts/.fonts/. Body text uses the system sans-serif.
//
// Usage: node scripts/generate-og.mjs [domain]
//   node scripts/generate-og.mjs records.charliegleason.com
import {
	existsSync,
	mkdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync, spawnSync } from "node:child_process";
import sharp from "sharp";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");
const fontsDir = join(__dirname, ".fonts");
const fontPath = join(fontsDir, "Fraunces144pt-SemiBold.ttf");
const outPath = join(root, "public", "og-image.png");

const domain = process.argv[2] ?? "records.charliegleason.com";

// ---- palette ---------------------------------------------------------------
const BG = "#171717";
const GOLD = "#d9a441"; // eyebrow
const WORDMARK = "#f5f5f5";
const MUTED = "#8f8f8f"; // domain line

// ---- ensure Fraunces is available ------------------------------------------
if (!existsSync(fontPath)) {
	mkdirSync(fontsDir, { recursive: true });
	const url =
		"https://raw.githubusercontent.com/googlefonts/fraunces/master/fonts/static/ttf/Fraunces144pt-SemiBold.ttf";
	console.log("Downloading Fraunces…");
	const res = await fetch(url);
	if (!res.ok) throw new Error(`Font download failed: ${res.status}`);
	writeFileSync(fontPath, Buffer.from(await res.arrayBuffer()));
}

// fontconfig config so rsvg-convert can see Fraunces + the system sans.
const fcConf = join(fontsDir, "fonts.conf");
writeFileSync(
	fcConf,
	`<?xml version="1.0"?>
<!DOCTYPE fontconfig SYSTEM "fonts.dtd">
<fontconfig>
  <dir>${fontsDir}</dir>
  <dir>/System/Library/Fonts</dir>
  <dir>/Library/Fonts</dir>
  <dir prefix="xdg">fonts</dir>
  <cachedir>${join(fontsDir, "cache")}</cachedir>
</fontconfig>
`,
);

// ---- layout ----------------------------------------------------------------
const W = 1200;
const H = 630;
const CY = 315; // vertical centre of the composition
const SANS =
	"-apple-system, BlinkMacSystemFont, 'Helvetica Neue', Helvetica, Arial, sans-serif";

// Badge: reuse the built logo512.png (yellow circle + sharp note, transparent).
const badgeURI = `data:image/png;base64,${readFileSync(
	join(root, "public", "logo512.png"),
).toString("base64")}`;
const BADGE = 250; // rendered badge box (visible circle ≈ 0.9×)
const badgeX = 110;
const textX = badgeX + BADGE + 40; // text block sits to the right of the badge

// Escape XML text
const esc = (s) =>
	s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// Rendered on a transparent canvas (no background) so it can be trimmed to its
// bounding box and re-centred within the frame below.
const svg = `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">
  <image href="${badgeURI}" x="${badgeX}" y="${CY - BADGE / 2}" width="${BADGE}" height="${BADGE}"/>
  <text x="${textX}" y="${CY - 63}" font-family="${SANS}" font-size="26" font-weight="600"
        letter-spacing="6" fill="${GOLD}">THE COLLECTION</text>
  <text x="${textX}" y="${CY + 58}" font-family="Fraunces 144pt, Fraunces, Georgia, serif"
        font-size="132" font-weight="600" fill="${WORDMARK}">Records</text>
  <text x="${textX}" y="${CY + 122}" font-family="${SANS}" font-size="38" font-weight="400" fill="${MUTED}">${esc(domain)}</text>
</svg>`;

const svgPath = join(fontsDir, "og.svg");
writeFileSync(svgPath, svg);

// ---- render (2x via rsvg-convert for crisp text) ---------------------------
// rsvg-convert is an external binary (librsvg). Fail early with an actionable
// message instead of a raw ENOENT from execFileSync below.
if (spawnSync("rsvg-convert", ["--version"]).error) {
	console.error(
		"rsvg-convert not found. Install librsvg:\n" +
			"  macOS:  brew install librsvg\n" +
			"  Debian: apt-get install librsvg2-bin",
	);
	process.exit(1);
}

const S = 2;
const pngRaw = join(fontsDir, "og@2x.png");
execFileSync(
	"rsvg-convert",
	["-w", String(W * S), "-h", String(H * S), svgPath, "-o", pngRaw],
	{ env: { ...process.env, FONTCONFIG_FILE: fcConf } },
);

// Trim to the content's bounding box, then composite it centred on the frame.
const content = await sharp(pngRaw).trim({ threshold: 1 }).png().toBuffer();
const { width: cw, height: ch } = await sharp(content).metadata();

const composed = await sharp({
	create: { width: W * S, height: H * S, channels: 4, background: BG },
})
	.composite([
		{
			input: content,
			left: Math.round((W * S - cw) / 2),
			top: Math.round((H * S - ch) / 2),
		},
	])
	.png()
	.toBuffer();

await sharp(composed).resize(W, H, { kernel: "lanczos3" }).png().toFile(outPath);

console.log(`Wrote ${outPath} — "${domain}"`);
