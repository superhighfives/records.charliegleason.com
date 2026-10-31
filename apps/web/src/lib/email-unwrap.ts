/**
 * Undoes the hard wrapping mail clients apply to plain-text email. A reply
 * typed as one flowing paragraph usually arrives broken at ~72–78 columns
 * (in the text part, or in HTML a client generated from it, as `<br>`s), and
 * the notes renderer turns every single newline into a visible line break
 * (`remark-breaks`, so pasted lyrics and lists keep their shape) — so the
 * wrap points showed up mid-sentence.
 *
 * A line is treated as wrapped, and joined to the next, when it's long
 * enough to have hit a wrap column. Short lines are deliberate breaks and
 * stay: lyrics, sign-offs, a list of names. Blank lines (paragraphs), list
 * items and quotes are never joined into.
 */

/** Shorter than any client's wrap column, longer than most deliberate lines. */
const WRAPPED_LINE_MIN = 60;

const BLOCK_START = /^\s*([-*+]\s|\d+[.)]\s|>)/;
const QUOTE = /^\s*>\s?/;

export function unwrapEmailText(text: string): string {
	const out: string[] = [];
	// Length of the last original line (not the joined result): whether the
	// next line continues it depends on whether *that* line hit the wrap.
	let lastLength = 0;
	for (const raw of text.replace(/\r\n?/g, "\n").split("\n")) {
		// Turndown writes `<br>` as a markdown hard break ("  " at the end),
		// which is the same wrap point.
		const line = raw.replace(/\s+$/, "");
		const prev = out.at(-1);
		if (
			prev != null &&
			lastLength >= WRAPPED_LINE_MIN &&
			continues(prev, line)
		) {
			const rest = QUOTE.test(prev)
				? line.replace(QUOTE, "")
				: line.trimStart();
			out[out.length - 1] = `${prev} ${rest}`;
		} else {
			out.push(line);
		}
		lastLength = line.length;
	}
	return out.join("\n");
}

function continues(prev: string, line: string): boolean {
	if (line.trim() === "" || prev.trim() === "") return false;
	// A wrapped quote carries on as another quoted line; anything else that
	// starts a block (a list item, a quote after prose) is its own line.
	if (QUOTE.test(prev)) return QUOTE.test(line);
	return !BLOCK_START.test(line);
}
