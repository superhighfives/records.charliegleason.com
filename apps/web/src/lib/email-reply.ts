/**
 * Tidies an email reply into notes markdown: drops the quoted chain below
 * it, undoes the client's hard wrapping, and squeezes out the blank space
 * email HTML leaves behind.
 */
export function cleanEmailReply(text: string): string {
	return unwrapEmailText(stripQuotedChain(text.replace(/\r\n?/g, "\n")))
		.split("\n")
		.map((line) => (line.trim() === "" ? "" : line))
		.join("\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

/**
 * The attribution line a client writes above the message being replied to —
 * "On Fri, 30 Oct 2026 at 06:00, Records Daily <…> wrote:", sometimes
 * wrapped onto a second line.
 */
const ATTRIBUTION = /^On\s[^\n]*(?:\n[^\n]*)?\swrote:\s*$/m;

/**
 * Mailgun's `stripped-*` fields are meant to leave out the quoted chain, but
 * Gmail's sometimes survives in `stripped-html`; everything from the
 * attribution line down is the old email, not the reply.
 */
function stripQuotedChain(text: string): string {
	const match = ATTRIBUTION.exec(text);
	return match ? text.slice(0, match.index) : text;
}

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
 * items and quotes are never joined — quotes here are nearly always lyrics,
 * where a long line is still a deliberate one.
 */

/**
 * Just under the narrowest wrap column clients use (72); a deliberate line
 * in the existing notes ran to 61, so this leaves a margin both ways.
 */
const WRAPPED_LINE_MIN = 70;

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
			out[out.length - 1] = `${prev} ${line.trimStart()}`;
		} else {
			out.push(line);
		}
		lastLength = line.length;
	}
	return out.join("\n");
}

function continues(prev: string, line: string): boolean {
	if (line.trim() === "" || prev.trim() === "") return false;
	// Quotes (lyrics) keep their lines, and nothing joins onto a line that
	// starts a block of its own (a list item, a quote after prose).
	return !QUOTE.test(prev) && !BLOCK_START.test(line);
}
