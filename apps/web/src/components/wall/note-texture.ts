import * as THREE from "three";

/**
 * The writing on a record's note slip: the opening words of its notes, set
 * in the same sans as the notes in the record panel (DM Sans), on yellow
 * paper. Only the top of the slip pokes out of the sleeve (about a third at
 * rest, half when it slides up on hover), so the writing starts right at the
 * top edge — the first lines read at rest, the rest appears as the note is
 * pulled — and stops, with an ellipsis, at the last line that shows in full
 * when pulled, rather than running on behind the sleeve and getting cut
 * through the middle.
 */

const FONT = "DM Sans";
// Medium weight holds up at the few pixels a slip gets on screen. Two lines
// read at rest and three when pulled; the third starts just below the slip's
// resting edge (a 0.115 / 0.3 peek is ~74 of 192), so it never shows
// half-cut.
const FONT_WEIGHT = 500;
const FONT_SIZE = 19;
const LINE_HEIGHT = 28;
/** Paper margins around the writing. */
const TOP = 18;
const SIDE = 18;
/** Layout units; the canvas is `RESOLUTION`× this, so small writing stays crisp. */
const WIDTH = 256;
const HEIGHT = 192;
const RESOLUTION = 2;

let fontReady: Promise<void> | null = null;

/**
 * Waits (once) for the notes font — the page already links it (see
 * `__root.tsx`), so this only makes sure it's loaded before a slip is drawn
 * onto a canvas, which can't fall back gracefully mid-render.
 */
export function loadNoteFont(): Promise<void> {
	fontReady ??= document.fonts
		.load(`${FONT_WEIGHT} ${FONT_SIZE}px "${FONT}"`)
		.then(
			() => undefined,
			() => undefined,
		);
	return fontReady;
}

/** Notes are markdown; the slip wants just the words. */
export function noteExcerpt(notes: string, words = 9): string {
	const plain = notes
		.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
		.replace(/[*_`#>~]/g, "")
		.replace(/\s+/g, " ")
		.trim();
	const parts = plain.split(" ");
	return parts.length > words ? `${parts.slice(0, words).join(" ")}…` : plain;
}

/** A little deterministic wobble per record, so no two slips match. */
function rand(seed: number) {
	let s = seed * 9301 + 49297;
	return () => {
		s = (s * 9301 + 49297) % 233280;
		return s / 233280;
	};
}

/**
 * `visible`: the share of the slip's height that shows when it's pulled
 * up; writing stops at the last line that fits there.
 */
export function makeNoteTexture(
	text: string,
	seed: number,
	visible: number,
): THREE.Texture {
	const canvas = document.createElement("canvas");
	canvas.width = WIDTH * RESOLUTION;
	canvas.height = HEIGHT * RESOLUTION;
	const ctx = canvas.getContext("2d");
	const r = rand(seed);
	if (ctx) {
		ctx.scale(RESOLUTION, RESOLUTION);
		// Paper: the brand yellow, with a faint speckle so it reads as stock.
		ctx.fillStyle = "#eab308";
		ctx.fillRect(0, 0, WIDTH, HEIGHT);
		for (let i = 0; i < 600; i++) {
			ctx.fillStyle = `rgba(90, 60, 0, ${r() * 0.06})`;
			ctx.fillRect(r() * WIDTH, r() * HEIGHT, 1.5, 1.5);
		}

		// Dark ink, set straight.
		ctx.fillStyle = "rgba(40, 26, 6, 0.94)";
		ctx.textBaseline = "top";
		ctx.font = `${FONT_WEIGHT} ${FONT_SIZE}px "${FONT}", system-ui, sans-serif`;
		const maxWidth = WIDTH - SIDE * 2 - 6;
		const lines: string[] = [];
		let line = "";
		for (const word of text.split(" ")) {
			const next = line ? `${line} ${word}` : word;
			if (ctx.measureText(next).width > maxWidth && line) {
				lines.push(line);
				line = word;
			} else {
				line = next;
			}
		}
		if (line) lines.push(line);
		// Only whole lines that show when the slip is pulled; if that cuts
		// the note short, the last one ends in an ellipsis.
		const fits = Math.max(
			1,
			Math.floor((visible * HEIGHT - TOP - 6) / LINE_HEIGHT),
		);
		if (lines.length > fits) {
			lines.length = fits;
			let last = lines[fits - 1].replace(/[\s.,;:!?…-]+$/, "");
			while (
				ctx.measureText(`${last}…`).width > maxWidth &&
				last.includes(" ")
			) {
				last = last.slice(0, last.lastIndexOf(" "));
			}
			lines[fits - 1] = `${last}…`;
		}
		lines.forEach((l, i) => {
			ctx.fillText(l, SIDE, TOP + i * LINE_HEIGHT);
		});
	}
	const texture = new THREE.CanvasTexture(canvas);
	texture.colorSpace = THREE.SRGBColorSpace;
	// It's usually seen small and at an angle: the sharpest filtering on offer
	// (three clamps this to what the GPU supports).
	texture.anisotropy = 16;
	return texture;
}
