#!/usr/bin/env node
// Upscale the source music-note glyph via Replicate (Real-ESRGAN).
// The glyph ships as a 160px raster embedded in public/favicon.svg; upscaling
// it 4x gives a crisp source for the og:image and larger icons.
//
// Usage: REPLICATE_API_KEY=... node scripts/upscale-note.mjs [input] [output]
//   input  defaults to <tmpdir>/note-orig.png
//   output defaults to <tmpdir>/note-upscaled.png
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const token = process.env.REPLICATE_API_KEY || process.env.REPLICATE_API_TOKEN;
if (!token) {
	console.error("Set REPLICATE_API_KEY (or REPLICATE_API_TOKEN).");
	process.exit(1);
}

const SCALE = 4;
const IN = process.argv[2] ?? join(tmpdir(), "note-orig.png");
const OUT = process.argv[3] ?? join(tmpdir(), "note-upscaled.png");

if (!existsSync(IN)) {
	console.error(
		`Input image not found: ${IN}\n` +
			"Pass a path as the first argument, or place the source PNG there.",
	);
	process.exit(1);
}

const dataUri = `data:image/png;base64,${readFileSync(IN).toString("base64")}`;

const create = await fetch(
	"https://api.replicate.com/v1/models/nightmareai/real-esrgan/predictions",
	{
		method: "POST",
		headers: {
			Authorization: `Bearer ${token}`,
			"Content-Type": "application/json",
			Prefer: "wait",
		},
		body: JSON.stringify({
			input: { image: dataUri, scale: SCALE, face_enhance: false },
		}),
	},
);

if (!create.ok) {
	console.error("Create failed:", create.status, await create.text());
	process.exit(1);
}

let pred = await create.json();
// Poll if the `Prefer: wait` header didn't fully resolve.
while (pred.status !== "succeeded" && pred.status !== "failed") {
	await new Promise((r) => setTimeout(r, 1500));
	pred = await (
		await fetch(pred.urls.get, { headers: { Authorization: `Bearer ${token}` } })
	).json();
	console.log("status:", pred.status);
}

if (pred.status === "failed") {
	console.error("Prediction failed:", pred.error);
	process.exit(1);
}

const url = Array.isArray(pred.output) ? pred.output[0] : pred.output;
const bytes = Buffer.from(await (await fetch(url)).arrayBuffer());
writeFileSync(OUT, bytes);
console.log(`Wrote ${OUT} (${bytes.length} bytes) from ${url}`);
