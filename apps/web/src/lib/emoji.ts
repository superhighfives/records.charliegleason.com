/**
 * charliegleason.com's emoji generator. Pass a percent-encoded emoji glyph
 * (e.g. "%F0%9F%92%BF" for 💿) and get back a rendered PNG URL — the same
 * source the homepage hero uses.
 */
export function emojiSrc(encoded: string) {
	return `https://www.charliegleason.com/api/emoji/${encoded}?detailed=false&animated=false`;
}
