// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import {
	describeMatteAuditReason,
	MatteAuditBadge,
} from "#/components/matte-audit-badge";

afterEach(() => {
	cleanup();
});

describe("describeMatteAuditReason", () => {
	it("maps a single known code to its human label", () => {
		expect(describeMatteAuditReason("inside")).toBe("hole inside the cover");
	});

	it("joins multiple codes, including a punch-through hole, into a comma list", () => {
		expect(describeMatteAuditReason("tint,edge,sparse,inside")).toBe(
			"colour cast, edge overrun, under-cropped (mostly transparent), hole inside the cover",
		);
	});

	it("falls back to the raw code for an unrecognized reason", () => {
		expect(describeMatteAuditReason("mystery")).toBe("mystery");
	});
});

describe("MatteAuditBadge", () => {
	it("spells out the inside-hole reason in its tooltip", () => {
		const { getByTitle } = render(<MatteAuditBadge reason="inside" />);
		expect(getByTitle(/hole inside the cover/, { exact: false })).toBeTruthy();
	});

	it("reads red and flagged for a fix-worthy reason", () => {
		const { getByText } = render(<MatteAuditBadge reason="edge" />);
		const badge = getByText("Matte flagged");
		expect(badge.className).toContain("text-red-600");
	});

	it("reads amber and non-flagged for a tint-only reason", () => {
		const { getByText } = render(<MatteAuditBadge reason="tint" />);
		const badge = getByText("Colour cast");
		expect(badge.className).toContain("text-amber-600");
	});

	it("reads red when tint is mixed with a fix-worthy code", () => {
		const { getByText } = render(<MatteAuditBadge reason="tint,edge" />);
		const badge = getByText("Matte flagged");
		expect(badge.className).toContain("text-red-600");
	});
});
