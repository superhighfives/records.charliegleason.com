// @vitest-environment jsdom
import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { FadeImage, isImageDecoded } from "#/components/fade-image";

// jsdom never actually loads images, so `HTMLImageElement.complete` isn't
// meaningful on its own — stub it on the prototype so each test decides whether
// an image counts as already-cached (which drives the mount-effect reveal path).
const originalComplete = Object.getOwnPropertyDescriptor(
	HTMLImageElement.prototype,
	"complete",
);
let complete = false;

beforeEach(() => {
	complete = false;
	Object.defineProperty(HTMLImageElement.prototype, "complete", {
		configurable: true,
		get: () => complete,
	});
});

afterEach(() => {
	cleanup();
	if (originalComplete) {
		Object.defineProperty(
			HTMLImageElement.prototype,
			"complete",
			originalComplete,
		);
	} else {
		// Restore the prototype to its original (no own `complete`) state.
		delete (HTMLImageElement.prototype as { complete?: unknown }).complete;
	}
});

/** The single `<img>` FadeImage renders. `alt=""` gives it a presentation role, so
 *  query the DOM directly rather than via an accessible role. */
function img(container: HTMLElement): HTMLImageElement {
	const el = container.querySelector("img");
	if (!el) throw new Error("no <img> rendered");
	return el;
}

describe("FadeImage", () => {
	it("starts hidden and fades in once the image loads", () => {
		const { container } = render(<FadeImage src="/api/photos/a" alt="" />);
		const el = img(container);

		expect(el.classList.contains("opacity-0")).toBe(true);
		expect(el.classList.contains("opacity-100")).toBe(false);

		fireEvent.load(el);

		expect(el.classList.contains("opacity-100")).toBe(true);
		expect(el.classList.contains("opacity-0")).toBe(false);
	});

	it("reveals immediately when the image is already cached (complete on mount)", () => {
		// A cached image is `complete` before `onLoad` can fire — the mount effect
		// should reveal it without waiting for a load event.
		complete = true;
		const { container } = render(<FadeImage src="/api/photos/a" alt="" />);

		expect(img(container).classList.contains("opacity-100")).toBe(true);
	});

	it("reveals on error so a broken src never stays invisible", () => {
		const { container } = render(<FadeImage src="/api/photos/broken" alt="" />);
		const el = img(container);
		expect(el.classList.contains("opacity-0")).toBe(true);

		fireEvent.error(el);

		expect(el.classList.contains("opacity-100")).toBe(true);
	});

	it("re-hides and fades in again when the src changes on a mounted instance", () => {
		const { container, rerender } = render(
			<FadeImage src="/api/photos/a" alt="" />,
		);
		const el = img(container);
		fireEvent.load(el);
		expect(el.classList.contains("opacity-100")).toBe(true);

		// Same element, new src (e.g. an admin thumbnail whose cover updated): the
		// reveal should reset so the new image gets the fade too.
		rerender(<FadeImage src="/api/photos/b" alt="" />);
		expect(el.classList.contains("opacity-0")).toBe(true);
		expect(el.classList.contains("opacity-100")).toBe(false);

		fireEvent.load(el);
		expect(el.classList.contains("opacity-100")).toBe(true);
	});

	it("keeps a cached image revealed after a src swap to another cached image", () => {
		complete = true;
		const { container, rerender } = render(
			<FadeImage src="/api/photos/a" alt="" />,
		);
		expect(img(container).classList.contains("opacity-100")).toBe(true);

		rerender(<FadeImage src="/api/photos/b" alt="" />);
		// The mount effect re-runs on the new src and sees it already complete.
		expect(img(container).classList.contains("opacity-100")).toBe(true);
	});

	it("lets a caller's className override the base transition while keeping the opacity toggle", () => {
		// A src not touched by any other test — `decodedSrcs` is module-scoped and
		// persists across tests, so reusing "/api/photos/a" here (already marked
		// decoded by the "keeps a cached image revealed" test above) would make
		// this mount revealed and mask the opacity-0 assertion below.
		const { container } = render(
			<FadeImage
				src="/api/photos/class-merge"
				alt=""
				className="size-full transition-[opacity,filter] duration-500"
			/>,
		);
		const el = img(container);

		// The caller's combined transition wins the class-group collision…
		expect(el.className).toContain("transition-[opacity,filter]");
		expect(el.classList.contains("transition-opacity")).toBe(false);
		expect(el.classList.contains("duration-700")).toBe(false);
		expect(el.classList.contains("duration-500")).toBe(true);
		// …while the opacity toggle and the reduced-motion opt-out survive the merge.
		expect(el.classList.contains("opacity-0")).toBe(true);
		expect(el.classList.contains("motion-reduce:transition-none")).toBe(true);
	});

	it("forwards alt, src, and other img attributes", () => {
		const { container } = render(
			<FadeImage
				src="/api/photos/a"
				alt="Cover art"
				loading="lazy"
				decoding="async"
			/>,
		);
		const el = img(container);

		expect(el.getAttribute("alt")).toBe("Cover art");
		expect(el.getAttribute("src")).toBe("/api/photos/a");
		expect(el.getAttribute("loading")).toBe("lazy");
		expect(el.getAttribute("decoding")).toBe("async");
	});

	it("calls onReady on load, on error, and immediately for a src already decoded this session", () => {
		const onReadyLoad = vi.fn();
		const { container: loadContainer } = render(
			<FadeImage src="/api/photos/onready-load" alt="" onReady={onReadyLoad} />,
		);
		fireEvent.load(img(loadContainer));
		expect(onReadyLoad).toHaveBeenCalledTimes(1);

		const onReadyError = vi.fn();
		const { container: errorContainer } = render(
			<FadeImage
				src="/api/photos/onready-error"
				alt=""
				onReady={onReadyError}
			/>,
		);
		fireEvent.error(img(errorContainer));
		expect(onReadyError).toHaveBeenCalledTimes(1);

		// Remount with a src already marked decoded (from the load above) — the
		// seeded/cached path a caller like the grid tile's peeking disc relies on
		// to skip a re-fade rather than replaying it on every remount.
		const onReadySeeded = vi.fn();
		render(
			<FadeImage
				src="/api/photos/onready-load"
				alt=""
				onReady={onReadySeeded}
			/>,
		);
		expect(onReadySeeded).toHaveBeenCalledTimes(1);
	});

	it("isImageDecoded reports whether a src has decoded this session", () => {
		expect(isImageDecoded("/api/photos/never-loaded")).toBe(false);
		expect(isImageDecoded(undefined)).toBe(false);

		const { container } = render(
			<FadeImage src="/api/photos/decoded-check" alt="" />,
		);
		expect(isImageDecoded("/api/photos/decoded-check")).toBe(false);

		fireEvent.load(img(container));
		expect(isImageDecoded("/api/photos/decoded-check")).toBe(true);
	});

	it("still calls a caller's onLoad and onError handlers", () => {
		const onLoad = vi.fn();
		const onError = vi.fn();
		const { container } = render(
			<FadeImage
				src="/api/photos/a"
				alt=""
				onLoad={onLoad}
				onError={onError}
			/>,
		);
		const el = img(container);

		fireEvent.load(el);
		expect(onLoad).toHaveBeenCalledTimes(1);

		fireEvent.error(el);
		expect(onError).toHaveBeenCalledTimes(1);
	});
});
