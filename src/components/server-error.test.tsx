// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

// ServerError's non-matched branch falls through to ErrorScreen's default
// "Back to the records" `<Link>`, which needs a RouterProvider we don't have
// in a plain component test — stub it down to a plain anchor.
vi.mock("@tanstack/react-router", () => ({
	Link: ({ children, to }: { children: React.ReactNode; to: string }) => (
		<a href={to}>{children}</a>
	),
}));

import { ServerError } from "#/components/server-error";
import { ADMIN_SESSION_ERROR_MESSAGE } from "#/lib/auth";

afterEach(cleanup);

describe("ServerError", () => {
	it("shows the reload screen for an admin session mismatch", () => {
		render(<ServerError error={new Error(ADMIN_SESSION_ERROR_MESSAGE)} />);

		expect(screen.getByText("Your session needs a moment")).toBeTruthy();
		expect(screen.getByRole("button", { name: "Reload" })).toBeTruthy();
	});

	it("shows the generic 500 screen for any other error", () => {
		render(<ServerError error={new Error("boom")} />);

		expect(screen.getByText("Something's warped")).toBeTruthy();
		expect(screen.queryByRole("button", { name: "Reload" })).toBeNull();
	});
});
