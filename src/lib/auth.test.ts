import { afterEach, describe, expect, it, vi } from "vitest";

const { setResponseStatus, setResponseHeader } = vi.hoisted(() => ({
	setResponseStatus: vi.fn(),
	setResponseHeader: vi.fn(),
}));

vi.mock("@tanstack/react-start/server", () => ({
	getRequest: vi.fn(),
	setResponseStatus,
	setResponseHeader,
}));

import { forwardHandshake } from "./auth";

describe("forwardHandshake", () => {
	afterEach(() => {
		vi.clearAllMocks();
	});

	it("sets a 307, forwards non-cookie headers, and batches Set-Cookie via getSetCookie", () => {
		const headers = new Headers();
		headers.append("Location", "https://clerk.example.com/handshake");
		headers.append("X-Custom", "value");
		headers.append("Set-Cookie", "a=1; Path=/");
		headers.append("Set-Cookie", "b=2; Path=/");

		forwardHandshake(headers);

		expect(setResponseStatus).toHaveBeenCalledWith(307);
		expect(setResponseHeader).toHaveBeenCalledWith(
			"location",
			"https://clerk.example.com/handshake",
		);
		expect(setResponseHeader).toHaveBeenCalledWith("x-custom", "value");
		// Forwarded as the array from getSetCookie(), not the comma-joined value
		// entries() would give for a repeated header.
		expect(setResponseHeader).toHaveBeenCalledWith("Set-Cookie", [
			"a=1; Path=/",
			"b=2; Path=/",
		]);
		expect(setResponseHeader).not.toHaveBeenCalledWith(
			"set-cookie",
			expect.anything(),
		);
	});

	it("skips the Set-Cookie header entirely when there are no cookies", () => {
		const headers = new Headers();
		headers.append("Location", "https://clerk.example.com/handshake");

		forwardHandshake(headers);

		expect(setResponseStatus).toHaveBeenCalledWith(307);
		expect(setResponseHeader).toHaveBeenCalledTimes(1);
		expect(setResponseHeader).toHaveBeenCalledWith(
			"location",
			"https://clerk.example.com/handshake",
		);
	});
});
