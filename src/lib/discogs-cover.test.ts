import { afterEach, describe, expect, it, vi } from "vitest";
import * as discogs from "./discogs";
import { discogsCoverResponse } from "./discogs-cover";

afterEach(() => {
	vi.restoreAllMocks();
});

describe("discogsCoverResponse", () => {
	it("rejects a non-numeric release id without touching the network", async () => {
		const spy = vi.spyOn(discogs, "getReleaseImageUrl");
		const res = await discogsCoverResponse("abc");
		expect(res.status).toBe(400);
		expect(spy).not.toHaveBeenCalled();
	});

	it("404s when the release has no resolvable cover", async () => {
		vi.spyOn(discogs, "getReleaseImageUrl").mockResolvedValue(null);
		const res = await discogsCoverResponse("123");
		expect(res.status).toBe(404);
	});

	it("streams the image bytes back with the upstream content type", async () => {
		vi.spyOn(discogs, "getReleaseImageUrl").mockResolvedValue(
			"https://i.discogs.com/cover.jpg",
		);
		const bytes = new Uint8Array([1, 2, 3, 4]);
		vi.stubGlobal(
			"fetch",
			vi.fn(
				async () =>
					new Response(bytes, { headers: { "content-type": "image/jpeg" } }),
			),
		);

		const res = await discogsCoverResponse("123");
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toBe("image/jpeg");
		expect(res.headers.get("cache-control")).toContain("max-age=3600");
		expect(new Uint8Array(await res.arrayBuffer())).toEqual(bytes);
	});

	it("502s when the upstream image fetch fails", async () => {
		vi.spyOn(discogs, "getReleaseImageUrl").mockResolvedValue(
			"https://i.discogs.com/cover.jpg",
		);
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response("nope", { status: 500 })),
		);

		const res = await discogsCoverResponse("123");
		expect(res.status).toBe(502);
	});
});
