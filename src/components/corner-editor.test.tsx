// @vitest-environment jsdom
import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CornerEditor } from "#/components/corner-editor";
import type { CornerBand } from "#/lib/sleeve-corners";

// jsdom never lays out elements, so clientWidth/clientHeight (which the loupe's
// "is the box measured yet" gate depends on) are always 0 — stub them so the
// component believes it has a real box to magnify over.
beforeEach(() => {
	vi.stubGlobal(
		"ResizeObserver",
		class {
			observe() {}
			disconnect() {}
		},
	);
	Object.defineProperty(HTMLElement.prototype, "clientWidth", {
		configurable: true,
		value: 400,
	});
	Object.defineProperty(HTMLElement.prototype, "clientHeight", {
		configurable: true,
		value: 400,
	});
});

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
});

const BAND: CornerBand = {
	outer: [
		[0.1, 0.1],
		[0.9, 0.1],
		[0.9, 0.9],
		[0.1, 0.9],
	],
	inner: [
		[0.2, 0.2],
		[0.8, 0.2],
		[0.8, 0.8],
		[0.2, 0.8],
	],
};

function loupe(container: HTMLElement) {
	return container.querySelector('[aria-hidden="true"].border-brand');
}

describe("CornerEditor keyboard loupe", () => {
	it("surfaces the loupe over the nudged handle on an arrow-key press", () => {
		const { container, getByLabelText } = render(
			<CornerEditor src="/api/photos/a" value={BAND} onChange={() => {}} />,
		);
		const handle = getByLabelText("Top-left outer corner");

		// A real Tab focus selects the handle without moving it — no loupe yet,
		// only a nudge should surface it.
		fireEvent.focus(handle);
		expect(loupe(container)).toBeNull();

		const gridContainer = container.querySelector(
			".cursor-crosshair",
		) as HTMLElement;
		fireEvent.keyDown(gridContainer, { key: "ArrowRight" });

		expect(loupe(container)).not.toBeNull();
	});

	it("clears a stale loupe when focus moves to a different handle without nudging it", () => {
		const { container, getByLabelText } = render(
			<CornerEditor src="/api/photos/a" value={BAND} onChange={() => {}} />,
		);
		const handle = getByLabelText("Top-left outer corner");
		const otherHandle = getByLabelText("Bottom-right outer corner");
		const gridContainer = container.querySelector(
			".cursor-crosshair",
		) as HTMLElement;

		fireEvent.focus(handle);
		fireEvent.keyDown(gridContainer, { key: "ArrowRight" });
		expect(loupe(container)).not.toBeNull();

		// Tab to a different handle (another real focus) without nudging it — the
		// previous corner's loupe shouldn't keep pointing at the wrong spot.
		fireEvent.focus(otherHandle);
		expect(loupe(container)).toBeNull();
	});
});
