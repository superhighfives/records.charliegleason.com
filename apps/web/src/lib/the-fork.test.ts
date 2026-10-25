import { describe, expect, it } from "vitest";
import { pitchforkRematchAction, sameAlbum } from "#/lib/the-fork";

const prev = {
	artist: "Ceres",
	title: "Drag It Down On You",
	pitchforkScore: 7.2,
};

describe("sameAlbum", () => {
	it("ignores case, accents and punctuation", () => {
		expect(
			sameAlbum(
				{ artist: "Beyoncé", title: "Lemonade!" },
				{ artist: "beyonce", title: "lemonade" },
			),
		).toBe(true);
		expect(
			sameAlbum(
				{ artist: "Ceres", title: "A" },
				{ artist: "Ceres", title: "B" },
			),
		).toBe(false);
	});
});

describe("pitchforkRematchAction", () => {
	it("keeps the score when the album didn't change", () => {
		expect(pitchforkRematchAction(prev, prev, 7.2)).toBe("keep");
		expect(
			pitchforkRematchAction(prev, { ...prev, title: "drag it down on you" }),
		).toBe("keep");
	});
	it("looks the new album up when the score is untouched, blank or absent", () => {
		const next = { artist: "Ceres", title: "Magic Mountain" };
		expect(pitchforkRematchAction(prev, next, 7.2)).toBe("lookup");
		expect(pitchforkRematchAction(prev, next, null)).toBe("lookup");
		expect(pitchforkRematchAction(prev, next)).toBe("lookup");
	});
	it("trusts a score typed in alongside the new match", () => {
		expect(
			pitchforkRematchAction(
				prev,
				{ artist: "Ceres", title: "Magic Mountain" },
				8.1,
			),
		).toBe("manual");
	});
});
