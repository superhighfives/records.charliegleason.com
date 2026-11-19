// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { useWallPage } from "#/components/wall/use-wall-page";

const root = document.documentElement;

function Page({ wallMode }: { wallMode: boolean }) {
	useWallPage(wallMode);
	return null;
}

afterEach(() => {
	cleanup();
	delete root.dataset.wall;
	delete root.dataset.wallReady;
});

describe("useWallPage", () => {
	it("marks the page as the wall's on mount, before any scene is up", () => {
		render(<Page wallMode />);
		expect("wall" in root.dataset).toBe(true);
	});

	it("leaves the grid's page alone", () => {
		render(<Page wallMode={false} />);
		expect("wall" in root.dataset).toBe(false);
	});

	it("keeps `wallReady` while staying on the wall", () => {
		// An empty result unmounts the scene but not the page: re-rendering on
		// the wall mustn't put the loading gate back.
		const { rerender } = render(<Page wallMode />);
		root.dataset.wallReady = "";
		rerender(<Page wallMode />);
		expect("wallReady" in root.dataset).toBe(true);
	});

	it("clears both flags on switching to the grid", () => {
		const { rerender } = render(<Page wallMode />);
		root.dataset.wallReady = "";
		rerender(<Page wallMode={false} />);
		expect("wall" in root.dataset).toBe(false);
		expect("wallReady" in root.dataset).toBe(false);
	});

	it("sets the wall again, waiting for a fresh scene, on switching back", () => {
		const { rerender } = render(<Page wallMode />);
		root.dataset.wallReady = "";
		rerender(<Page wallMode={false} />);
		rerender(<Page wallMode />);
		expect("wall" in root.dataset).toBe(true);
		expect("wallReady" in root.dataset).toBe(false);
	});

	it("clears both flags when the page unmounts", () => {
		const { unmount } = render(<Page wallMode />);
		root.dataset.wallReady = "";
		unmount();
		expect("wall" in root.dataset).toBe(false);
		expect("wallReady" in root.dataset).toBe(false);
	});
});
