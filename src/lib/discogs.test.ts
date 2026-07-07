import { afterEach, describe, expect, it, vi } from "vitest";

import {
	buildSearchUrl,
	parseReleaseId,
	parseSizeAndType,
	pickSuggestedValue,
	searchReleases,
} from "./discogs";

const noParams = { artist: "x", title: "", country: "", year: "", q: "" };

describe("parseReleaseId", () => {
	it("pulls the id from a full release URL with a slug", () => {
		expect(
			parseReleaseId(
				"https://www.discogs.com/release/30268103-Private-Life-Private-Life",
			),
		).toBe("30268103");
	});

	it("accepts bare /release/<id> and plural /releases/<id> paths", () => {
		expect(parseReleaseId("/release/30268103")).toBe("30268103");
		expect(parseReleaseId("/releases/30268103")).toBe("30268103");
	});

	it("accepts a bare numeric id, trimming whitespace", () => {
		expect(parseReleaseId("  30268103  ")).toBe("30268103");
	});

	it("returns null for non-release URLs and empty input", () => {
		expect(parseReleaseId("https://www.discogs.com/artist/12345-Wire")).toBe(
			null,
		);
		expect(parseReleaseId("https://www.discogs.com/master/98765")).toBe(null);
		expect(parseReleaseId("")).toBe(null);
	});
});

describe("pickSuggestedValue", () => {
	it("prefers the VG+ grade and reports its currency", () => {
		const { value, currency, suggestions } = pickSuggestedValue({
			"Mint (M)": { value: 40, currency: "USD" },
			"Near Mint (NM or M-)": { value: 30, currency: "USD" },
			"Very Good Plus (VG+)": { value: 22.5, currency: "USD" },
			"Very Good (VG)": { value: 15, currency: "USD" },
		});
		expect(value).toBe(22.5);
		expect(currency).toBe("USD");
		// Every well-formed grade is kept in the flat breakdown.
		expect(suggestions["Mint (M)"]).toBe(40);
		expect(Object.keys(suggestions)).toHaveLength(4);
	});

	it("falls back down the grade priority when VG+ is absent", () => {
		const { value } = pickSuggestedValue({
			"Near Mint (NM or M-)": { value: 30, currency: "USD" },
			"Very Good (VG)": { value: 15, currency: "USD" },
		});
		expect(value).toBe(30);
	});

	it("drops malformed, null, empty and non-positive entries", () => {
		const { value, suggestions } = pickSuggestedValue({
			"Mint (M)": { value: "not a number", currency: "USD" },
			// `Number(null)`/`Number("")` are 0 (finite) — these must not slip through
			// as a bogus $0 suggestion.
			"Near Mint (NM or M-)": { value: null, currency: "USD" },
			"Very Good Plus (VG+)": { value: "", currency: "USD" },
			"Good (G)": { value: 0, currency: "USD" },
			"Very Good (VG)": null,
		});
		expect(value).toBe(null);
		expect(suggestions).toEqual({});
	});
});

describe("buildSearchUrl", () => {
	const params = (over = {}) => ({
		artist: "",
		title: "",
		country: "",
		year: "",
		q: "",
		...over,
	});

	it("maps artist/title to the Discogs param names", () => {
		const url = buildSearchUrl(params({ artist: "Led Zeppelin", title: "IV" }));
		expect(url.searchParams.get("type")).toBe("release");
		expect(url.searchParams.get("artist")).toBe("Led Zeppelin");
		expect(url.searchParams.get("release_title")).toBe("IV");
	});

	it("includes country and a valid 4-digit year", () => {
		const url = buildSearchUrl(params({ country: "UK", year: "1971" }));
		expect(url.searchParams.get("country")).toBe("UK");
		expect(url.searchParams.get("year")).toBe("1971");
	});

	it("omits empty fields", () => {
		const url = buildSearchUrl(params({ artist: "Pixies" }));
		expect(url.searchParams.has("release_title")).toBe(false);
		expect(url.searchParams.has("country")).toBe(false);
		expect(url.searchParams.has("year")).toBe(false);
		expect(url.searchParams.has("q")).toBe(false);
	});

	it("maps free-text keywords to the general q param, trimming whitespace", () => {
		const url = buildSearchUrl(params({ q: "  4AD CAD 2007  " }));
		expect(url.searchParams.get("q")).toBe("4AD CAD 2007");
	});

	it("trims whitespace before setting params", () => {
		const url = buildSearchUrl(
			params({ artist: "  Björk  ", country: " IS ", year: " 1997 " }),
		);
		expect(url.searchParams.get("artist")).toBe("Björk");
		expect(url.searchParams.get("country")).toBe("IS");
		expect(url.searchParams.get("year")).toBe("1997");
	});

	it("drops a non-4-digit year rather than sending junk", () => {
		expect(
			buildSearchUrl(params({ year: "71" })).searchParams.has("year"),
		).toBe(false);
		expect(
			buildSearchUrl(params({ year: "nineteen" })).searchParams.has("year"),
		).toBe(false);
	});

	it("requests the default page size, or a custom one", () => {
		expect(buildSearchUrl(params()).searchParams.get("per_page")).toBe("25");
		expect(buildSearchUrl(params(), 100).searchParams.get("per_page")).toBe(
			"100",
		);
	});
});

describe("searchReleases", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
		vi.useRealTimers();
	});

	const respond = (init: ResponseInit, body: unknown = {}) => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response(JSON.stringify(body), init)),
		);
	};

	it("returns [] for a genuine zero-match (200 with no results)", async () => {
		respond({ status: 200 }, { results: [] });
		await expect(searchReleases(noParams)).resolves.toEqual([]);
	});

	it("caps results at the limit — the default shortlist, or a larger page", async () => {
		const results = Array.from({ length: 20 }, (_, i) => ({
			id: i,
			title: `Artist - Title ${i}`,
			format: ["Vinyl", "LP"],
		}));
		// Default limit is the analyze-path shortlist.
		respond({ status: 200 }, { results });
		await expect(searchReleases(noParams)).resolves.toHaveLength(15);
		// A larger limit (the manual search) returns the whole page.
		respond({ status: 200 }, { results });
		await expect(searchReleases(noParams, 100)).resolves.toHaveLength(20);
	});

	it("throws — not [] — on a 401 so a bad token surfaces", async () => {
		respond({ status: 401 }, { message: "You must authenticate…" });
		await expect(searchReleases(noParams)).rejects.toThrow(/DISCOGS_TOKEN/);
	});

	it("throws a rate-limit message on a 429", async () => {
		respond({ status: 429 }, {});
		await expect(searchReleases(noParams)).rejects.toThrow(/rate limit/i);
	});

	it("throws with the status for other failures", async () => {
		respond({ status: 500 }, {});
		await expect(searchReleases(noParams)).rejects.toThrow(/HTTP 500/);
	});

	it("retries a transient 503 and succeeds on a later attempt", async () => {
		// Fake timers so the backoff sleep doesn't run in real time — advance them
		// while the retry loop is awaiting, then assert the settled result.
		vi.useFakeTimers();
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(new Response("{}", { status: 503 }))
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ results: [] }), { status: 200 }),
			);
		vi.stubGlobal("fetch", fetchMock);
		const promise = searchReleases(noParams);
		await vi.runAllTimersAsync();
		await expect(promise).resolves.toEqual([]);
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it("retries a thrown fetch (network blip) then succeeds", async () => {
		vi.useFakeTimers();
		const fetchMock = vi
			.fn()
			.mockRejectedValueOnce(new TypeError("network error"))
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ results: [] }), { status: 200 }),
			);
		vi.stubGlobal("fetch", fetchMock);
		const promise = searchReleases(noParams);
		await vi.runAllTimersAsync();
		await expect(promise).resolves.toEqual([]);
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it("gives up after a few attempts on a persistent 500", async () => {
		vi.useFakeTimers();
		const fetchMock = vi.fn(async () => new Response("{}", { status: 500 }));
		vi.stubGlobal("fetch", fetchMock);
		const promise = searchReleases(noParams);
		// Attach a rejection handler before advancing timers so the eventual throw
		// isn't flagged as an unhandled rejection mid-run.
		const settled = expect(promise).rejects.toThrow(/HTTP 500/);
		await vi.runAllTimersAsync();
		await settled;
		expect(fetchMock).toHaveBeenCalledTimes(3);
	});

	it("does not retry a 401 — a bad token won't fix itself", async () => {
		const fetchMock = vi.fn(
			async () =>
				new Response(JSON.stringify({ message: "nope" }), { status: 401 }),
		);
		vi.stubGlobal("fetch", fetchMock);
		await expect(searchReleases(noParams)).rejects.toThrow(/DISCOGS_TOKEN/);
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});
});

describe("parseSizeAndType", () => {
	it("reads size and type from a descriptions array", () => {
		expect(parseSizeAndType(['12"', "33 ⅓ RPM", "LP", "Album"])).toEqual({
			size: '12"',
			type: "LP",
		});
	});

	it("accepts a joined format string", () => {
		expect(parseSizeAndType('Vinyl, 7", 45 RPM, Single')).toEqual({
			size: '7"',
			type: "Single",
		});
	});

	it("folds Album to LP when nothing more specific is present", () => {
		// A 12" album is often tagged "Album" with no "LP".
		expect(parseSizeAndType(['12"', "33 ⅓ RPM", "Album"])).toEqual({
			size: '12"',
			type: "LP",
		});
	});

	it('defaults a size-less LP to 12" (Discogs omits it for standard LPs)', () => {
		// e.g. Radiohead — In Rainbows: descriptions are ["LP", "Album", "Reissue"].
		expect(parseSizeAndType(["LP", "Album", "Reissue"])).toEqual({
			size: '12"',
			type: "LP",
		});
	});

	it('does not default a non-vinyl "Album" to 12"', () => {
		// "Album" folds to type LP, but a CD is not a 12" record — the vinyl guard
		// keeps the size null here.
		expect(parseSizeAndType(["CD", "Album", "Reissue"])).toEqual({
			size: null,
			type: "LP",
		});
	});

	it("prefers EP and Single over LP/Album", () => {
		expect(parseSizeAndType('12", EP').type).toBe("EP");
		expect(parseSizeAndType('12", Maxi-Single, 45 RPM').type).toBe("Single");
	});

	it('handles 10" pressings', () => {
		expect(parseSizeAndType(['10"', "EP"])).toEqual({
			size: '10"',
			type: "EP",
		});
	});

	it("returns nulls for empty or unrecognised input", () => {
		expect(parseSizeAndType(null)).toEqual({ size: null, type: null });
		expect(parseSizeAndType("")).toEqual({ size: null, type: null });
		expect(parseSizeAndType("Vinyl")).toEqual({ size: null, type: null });
	});
});
