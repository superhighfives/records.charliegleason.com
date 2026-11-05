import { describe, expect, it } from "vitest";

import {
	cleanEmailReply,
	replyToNotes,
	unwrapEmailText,
} from "#/lib/email-reply";

describe("unwrapEmailText", () => {
	it("rejoins a paragraph a mail client hard-wrapped", () => {
		const text = [
			"I grew up listening to Romeo and Juliet but I don't think I understood the",
			"cultural significance of Mark Knopfler until years later. But those opening",
			"chords. So good.",
		].join("\n");
		expect(unwrapEmailText(text)).toBe(
			"I grew up listening to Romeo and Juliet but I don't think I understood the cultural significance of Mark Knopfler until years later. But those opening chords. So good.",
		);
	});

	it("treats Turndown's <br> hard breaks as wrap points too", () => {
		const text =
			"I grew up listening to Romeo and Juliet but I don't think I understood the  \ncultural significance.";
		expect(unwrapEmailText(text)).toBe(
			"I grew up listening to Romeo and Juliet but I don't think I understood the cultural significance.",
		);
	});

	it("keeps short, deliberate line breaks", () => {
		const lyrics =
			"A love-struck Romeo\nSings the streets a serenade\nLaying everybody low";
		expect(unwrapEmailText(lyrics)).toBe(lyrics);
	});

	it("keeps paragraphs apart", () => {
		const text = [
			"I grew up listening to Romeo and Juliet but I don't think I understood the",
			"cultural significance.",
			"",
			"Second paragraph.",
		].join("\n");
		expect(unwrapEmailText(text)).toBe(
			"I grew up listening to Romeo and Juliet but I don't think I understood the cultural significance.\n\nSecond paragraph.",
		);
	});

	it("doesn't join a list item onto the line before", () => {
		const text = [
			"Favourite tracks on this one, in no particular order, for what it's worth:",
			"- Romeo and Juliet",
			"- Tunnel of Love",
		].join("\n");
		expect(unwrapEmailText(text)).toBe(text);
	});

	it("keeps quoted lyrics line by line, even long lines", () => {
		const text = [
			"> Garden shed, garden shed, garden shed",
			"> Garden shed for the garçons, them feelings that I was guardin' and more",
			"> Heavy on my mind, all my friends lost",
		].join("\n");
		expect(unwrapEmailText(text)).toBe(text);
	});

	it("keeps a deliberate break after a line shorter than a wrap column", () => {
		const text =
			"Garden shed for the garçons, them feelings that I was guardin'\nHeavy on my mind";
		expect(unwrapEmailText(text)).toBe(text);
	});

	it("normalises CRLF line endings", () => {
		const text =
			"I grew up listening to Romeo and Juliet but I don't think I understood the\r\ncultural significance.";
		expect(unwrapEmailText(text)).toBe(
			"I grew up listening to Romeo and Juliet but I don't think I understood the cultural significance.",
		);
	});
});

describe("cleanEmailReply", () => {
	it("drops the quoted email below the attribution line", () => {
		const text = [
			"Calais to Dover is so good.",
			"",
			"On Fri, 30 Oct 2026 at 06:00, Records Daily <[digest@charliegleason.com](mailto:digest@charliegleason.com)> wrote:",
			"",
			"> Bright Eyes — Down In The Weeds, Where The World Once Was",
			"> Reply to this email to add it as this record's notes.",
		].join("\n");
		expect(cleanEmailReply(text)).toBe("Calais to Dover is so good.");
	});

	it("drops an attribution a client wrapped onto two lines", () => {
		const text =
			"So good.\n\nOn Fri, 30 Oct 2026 at 06:00, Records Daily <digest@charliegleason.com>\nwrote:\n\n> Old email";
		expect(cleanEmailReply(text)).toBe("So good.");
	});

	it("squeezes blank space and whitespace-only lines", () => {
		const text =
			"> Wake up, wake up, it's Monday morning\n\n  \n\nI love the juxtapositions.\n\n  \n";
		expect(cleanEmailReply(text)).toBe(
			"> Wake up, wake up, it's Monday morning\n\nI love the juxtapositions.",
		);
	});

	it("leaves a sentence that merely mentions writing alone", () => {
		const text = "I wrote about this one before.\nOn reflection, still great.";
		expect(cleanEmailReply(text)).toBe(text);
	});

	it("keeps a line that only looks like an attribution, and what follows", () => {
		const text =
			"On Friday I wrote:\n\n> A love-struck Romeo\n> Sings the streets a serenade";
		expect(cleanEmailReply(text)).toBe(text);
	});
});

describe("replyToNotes", () => {
	it("keeps typed quotes and list items as markdown, not escaped", () => {
		const html =
			'<div dir="ltr">&gt; Threw up on the ferry ride<br>&gt; As pale as the white cliffs<br><br>- one<br>- two</div>';
		expect(replyToNotes(html, "")).toBe(
			"> Threw up on the ferry ride\n> As pale as the white cliffs\n\n- one\n- two",
		);
	});

	it("turns HTML links and bold into markdown", () => {
		const html =
			'<div>Calais to <a href="https://example.com">Dover</a> is <b>so</b> good.</div>';
		expect(replyToNotes(html, "")).toBe(
			"Calais to [Dover](https://example.com) is **so** good.",
		);
	});

	it("falls back to the plain-text part", () => {
		expect(replyToNotes("", "So good.\r\n")).toBe("So good.");
	});
});
