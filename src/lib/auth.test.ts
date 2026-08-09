import { afterEach, describe, expect, it, vi } from "vitest";

const { setResponseStatus, setResponseHeader, authenticateRequest } =
	vi.hoisted(() => ({
		setResponseStatus: vi.fn(),
		setResponseHeader: vi.fn(),
		authenticateRequest: vi.fn(),
	}));

vi.mock("@tanstack/react-start/server", () => ({
	getRequest: vi.fn(() => new Request("https://example.com")),
	setResponseStatus,
	setResponseHeader,
}));

vi.mock("@clerk/backend", () => ({
	createClerkClient: vi.fn(() => ({ authenticateRequest })),
}));

import { env } from "cloudflare:workers";
import { getAdminSession } from "./auth";

describe("getAdminSession handshake handling", () => {
	afterEach(() => {
		vi.clearAllMocks();
	});

	it("forwards the handshake redirect and resolves null, without evaluating auth", async () => {
		env.CLERK_SECRET_KEY = "sk_test";

		const headers = new Headers();
		headers.append("Location", "https://clerk.example.com/handshake");
		headers.append("X-Custom", "value");
		headers.append("Set-Cookie", "a=1; Path=/");
		headers.append("Set-Cookie", "b=2; Path=/");
		authenticateRequest.mockResolvedValue({
			status: "handshake",
			headers,
			toAuth: () => {
				throw new Error("toAuth should not be called during a handshake");
			},
		});

		const result = await getAdminSession();

		expect(result).toBeNull();
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

	it("skips the Set-Cookie header entirely on a handshake with no cookies", async () => {
		env.CLERK_SECRET_KEY = "sk_test";

		const headers = new Headers();
		headers.append("Location", "https://clerk.example.com/handshake");
		authenticateRequest.mockResolvedValue({
			status: "handshake",
			headers,
			toAuth: () => {
				throw new Error("toAuth should not be called during a handshake");
			},
		});

		const result = await getAdminSession();

		expect(result).toBeNull();
		expect(setResponseStatus).toHaveBeenCalledWith(307);
		expect(setResponseHeader).toHaveBeenCalledTimes(1);
		expect(setResponseHeader).toHaveBeenCalledWith(
			"location",
			"https://clerk.example.com/handshake",
		);
	});

	it("resolves null without touching the response when signed out cleanly", async () => {
		env.CLERK_SECRET_KEY = "sk_test";

		authenticateRequest.mockResolvedValue({
			status: "signed-out",
			toAuth: () => null,
		});

		const result = await getAdminSession();

		expect(result).toBeNull();
		expect(setResponseStatus).not.toHaveBeenCalled();
		expect(setResponseHeader).not.toHaveBeenCalled();
	});
});
