import { describe, expect, it } from "vitest";

import { unwrapEmailText } from "#/lib/email-unwrap";

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

	it("rejoins a wrapped quote without repeating its marker", () => {
		const text = [
			"> A love-struck Romeo sings the streets a serenade, laying everybody low",
			"> with a love song that he made.",
		].join("\n");
		expect(unwrapEmailText(text)).toBe(
			"> A love-struck Romeo sings the streets a serenade, laying everybody low with a love song that he made.",
		);
	});

	it("normalises CRLF line endings", () => {
		const text =
			"I grew up listening to Romeo and Juliet but I don't think I understood the\r\ncultural significance.";
		expect(unwrapEmailText(text)).toBe(
			"I grew up listening to Romeo and Juliet but I don't think I understood the cultural significance.",
		);
	});
});
