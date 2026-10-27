import * as THREE from "three";

/**
 * The handwriting on a record's note slip: the opening words of its notes in
 * a hand font, on yellow paper. Only the top of the slip pokes out of the
 * sleeve (about a third at rest, half when it slides up on hover), so the
 * writing starts right at the top edge — the first line reads at rest, the
 * second appears as the note is pulled.
 */

const FONT = "Caveat";
const FONT_CSS =
	"https://fonts.googleapis.com/css2?family=Caveat:wght@600&display=swap";
const WIDTH = 256;
const HEIGHT = 192;

let fontReady: Promise<void> | null = null;

/**
 * Loads the hand font once, on demand — only the 3D wall uses it, so it
 * stays out of the page's own font request.
 */
export function loadNoteFont(): Promise<void> {
	if (!fontReady) {
		const link = document.createElement("link");
		link.rel = "stylesheet";
		link.href = FONT_CSS;
		document.head.appendChild(link);
		fontReady = new Promise<void>((resolve) => {
			link.onload = () => resolve();
			link.onerror = () => resolve();
		})
			.then(() => document.fonts.load(`600 40px ${FONT}`))
			.then(
				() => undefined,
				() => undefined,
			);
	}
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

export function makeNoteTexture(text: string, seed: number): THREE.Texture {
	const canvas = document.createElement("canvas");
	canvas.width = WIDTH;
	canvas.height = HEIGHT;
	const ctx = canvas.getContext("2d");
	const r = rand(seed);
	if (ctx) {
		// Paper: the brand yellow, with a faint speckle so it reads as stock.
		ctx.fillStyle = "#eab308";
		ctx.fillRect(0, 0, WIDTH, HEIGHT);
		for (let i = 0; i < 600; i++) {
			ctx.fillStyle = `rgba(90, 60, 0, ${r() * 0.06})`;
			ctx.fillRect(r() * WIDTH, r() * HEIGHT, 1.5, 1.5);
		}

		// Pencil-ish ink, a touch uneven line to line.
		ctx.fillStyle = "rgba(48, 32, 10, 0.88)";
		ctx.textBaseline = "top";
		ctx.font = `600 34px ${FONT}, cursive`;
		const maxWidth = WIDTH - 28;
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
		lines.slice(0, 4).forEach((l, i) => {
			ctx.save();
			ctx.translate(14 + r() * 6, 10 + i * 36 + r() * 3);
			ctx.rotate((r() - 0.5) * 0.04);
			ctx.fillText(l, 0, 0);
			ctx.restore();
		});
	}
	const texture = new THREE.CanvasTexture(canvas);
	texture.colorSpace = THREE.SRGBColorSpace;
	texture.anisotropy = 4;
	return texture;
}
