import { describe, expect, it } from "vitest";

import {
	mapMasterDetail,
	mapMasterSearchResult,
	mapReleaseCandidate,
	mapReleaseSearchResult,
	masterDetailToCandidate,
} from "./discogs-shared";

describe("mapReleaseSearchResult", () => {
	it("maps a populated release search row", () => {
		const c = mapReleaseSearchResult({
			id: 123,
			title: "Wire - Pink Flag",
			year: "1977",
			label: ["Harvest"],
			genre: ["Rock"],
			format: ["Vinyl", "LP", "Album"],
			country: "UK",
			uri: "/release/123",
		});
		expect(c).toMatchObject({
			discogsId: "123",
			artist: "Wire",
			title: "Pink Flag",
			label: "Harvest",
			genre: "Rock",
			country: "UK",
		});
	});

	it("nulls empty label/genre arrays instead of the string \"undefined\"", () => {
		// The bug this guards: `String([][0])` is `"undefined"`, so an empty array
		// would otherwise persist + display the literal word "undefined".
		const c = mapReleaseSearchResult({ id: 1, title: "A - B", label: [], genre: [] });
		expect(c.label).toBeNull();
		expect(c.genre).toBeNull();
	});
});

describe("mapMasterSearchResult", () => {
	it("nulls an empty genre array instead of the string \"undefined\"", () => {
		const c = mapMasterSearchResult({ id: 9, title: "A - B", genre: [] });
		expect(c.genre).toBeNull();
	});
});

describe("mapReleaseCandidate", () => {
	it("shapes a full release payload into a candidate", () => {
		const c = mapReleaseCandidate(
			{
				id: 30268103,
				artists_sort: "Wire (2)",
				title: "Pink Flag",
				year: 1977,
				country: "UK",
				genres: ["Rock"],
				labels: [{ name: "Harvest", catno: "SHSP 4076" }],
				formats: [{ name: "Vinyl", qty: "1", descriptions: ["LP", "Album"] }],
				master_id: 12345,
				master_url: "https://api.discogs.com/masters/12345",
				uri: "/release/30268103-Wire-Pink-Flag",
				images: [{ type: "primary", uri150: "https://img/150.jpg" }],
			},
			"30268103",
		);
		expect(c).toMatchObject({
			discogsId: "30268103",
			masterId: "12345",
			artist: "Wire", // disambiguation suffix stripped
			title: "Pink Flag",
			year: 1977,
			label: "Harvest",
			catno: "SHSP 4076",
			country: "UK",
			size: '12"',
			type: "LP",
			thumb: "https://img/150.jpg",
			discogsUrl: "https://www.discogs.com/release/30268103-Wire-Pink-Flag",
		});
	});

	it("returns a null thumb when images are absent (unauthenticated fetch)", () => {
		const c = mapReleaseCandidate(
			{ id: 1, title: "X", uri: "/release/1" },
			"1",
		);
		expect(c.thumb).toBeNull();
		expect(c.discogsId).toBe("1");
	});

	it("normalises a `none` catalog number and a zero master_id to null", () => {
		const c = mapReleaseCandidate(
			{ id: 2, title: "Y", labels: [{ catno: "none" }], master_id: 0 },
			"2",
		);
		expect(c.catno).toBeNull();
		expect(c.masterId).toBeNull();
		// No `uri` → fall back to a canonical release URL built from the id.
		expect(c.discogsUrl).toBe("https://www.discogs.com/release/2");
	});
});

describe("mapMasterDetail + masterDetailToCandidate", () => {
	it("shapes a master payload and derives a candidate", () => {
		const detail = mapMasterDetail(
			{
				id: 12345,
				title: "Pink Flag",
				year: 1977,
				genres: ["Rock"],
				artists: [{ name: "Wire (2)" }],
				main_release: 999,
				uri: "/master/12345-Wire-Pink-Flag",
				images: [{ type: "primary", uri: "https://img/full.jpg" }],
			},
			"12345",
		);
		expect(detail).toMatchObject({
			masterId: "12345",
			mainReleaseId: "999",
			artist: "Wire",
			title: "Pink Flag",
			year: 1977,
			imageUrl: "https://img/full.jpg",
		});
		expect(masterDetailToCandidate(detail)).toMatchObject({
			masterId: "12345",
			artist: "Wire",
			title: "Pink Flag",
			thumb: "https://img/full.jpg",
		});
	});

	it("null imageUrl/thumb when images are absent, with a fallback masterUrl", () => {
		const detail = mapMasterDetail({ id: 7, title: "Z" }, "7");
		expect(detail.imageUrl).toBeNull();
		expect(detail.masterUrl).toBe("https://www.discogs.com/master/7");
		expect(masterDetailToCandidate(detail).thumb).toBeNull();
	});
});
