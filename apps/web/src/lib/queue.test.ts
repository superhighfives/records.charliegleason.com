import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The pipeline modules queue.ts pulls in aren't exercised here — stub them so the
// import stays cheap and binding-free.
vi.mock("#/db", () => ({ getDb: vi.fn() }));
vi.mock("#/lib/analyze", () => ({}));
vi.mock("#/lib/asin", () => ({}));
vi.mock("#/lib/capture-first-pass", () => ({}));
vi.mock("#/lib/color-texture", () => ({}));
vi.mock("#/lib/discogs", () => ({}));
vi.mock("#/lib/professional-pipeline", () => ({}));
vi.mock("@sentry/cloudflare", () => ({ captureException: vi.fn() }));

import { env } from "cloudflare:workers";
import type { AnalyzeMessage } from "#/lib/batching";
import { enqueueDeletePhotos, handleAnalyzeBatch } from "#/lib/queue";

const send = vi.fn();
const photosDelete = vi.fn();

beforeEach(() => {
	Object.assign(env, {
		ANALYZE_QUEUE: { send },
		PHOTOS: { delete: photosDelete },
	});
	vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
	vi.resetAllMocks();
	vi.restoreAllMocks();
});

describe("enqueueDeletePhotos", () => {
	it("is a no-op for no keys", async () => {
		await enqueueDeletePhotos([]);
		expect(send).not.toHaveBeenCalled();
		expect(photosDelete).not.toHaveBeenCalled();
	});

	it("defers the delete by the grace period", async () => {
		send.mockResolvedValue(undefined);
		await enqueueDeletePhotos(["a.jpg", "a-640.jpg"]);
		expect(send).toHaveBeenCalledWith(
			{ mode: "delete-photos", keys: ["a.jpg", "a-640.jpg"] },
			{ delaySeconds: 60 * 60 },
		);
		expect(photosDelete).not.toHaveBeenCalled();
	});

	it("deletes immediately when the send fails", async () => {
		send.mockRejectedValue(new Error("queue down"));
		photosDelete.mockResolvedValue(undefined);
		await enqueueDeletePhotos(["a.jpg"]);
		expect(photosDelete).toHaveBeenCalledWith(["a.jpg"]);
	});

	it("swallows a failed fallback delete", async () => {
		send.mockRejectedValue(new Error("queue down"));
		photosDelete.mockRejectedValue(new Error("r2 down"));
		await expect(enqueueDeletePhotos(["a.jpg"])).resolves.toBeUndefined();
	});
});

describe("delete-photos consumer", () => {
	function deleteMessage(attempts: number) {
		return {
			body: { mode: "delete-photos", keys: ["a.jpg"] } as AnalyzeMessage,
			attempts,
			ack: vi.fn(),
			retry: vi.fn(),
		};
	}

	function run(message: ReturnType<typeof deleteMessage>) {
		return handleAnalyzeBatch({
			messages: [message],
		} as unknown as MessageBatch<AnalyzeMessage>);
	}

	it("deletes the keys and acks", async () => {
		photosDelete.mockResolvedValue(undefined);
		const message = deleteMessage(1);
		await run(message);
		expect(photosDelete).toHaveBeenCalledWith(["a.jpg"]);
		expect(message.ack).toHaveBeenCalled();
		expect(message.retry).not.toHaveBeenCalled();
	});

	it("retries a failed delete", async () => {
		photosDelete.mockRejectedValue(new Error("r2 down"));
		const message = deleteMessage(1);
		await run(message);
		expect(message.retry).toHaveBeenCalled();
		expect(message.ack).not.toHaveBeenCalled();
	});

	it("gives up after the last retry", async () => {
		photosDelete.mockRejectedValue(new Error("r2 down"));
		const message = deleteMessage(4);
		await run(message);
		expect(message.ack).toHaveBeenCalled();
		expect(message.retry).not.toHaveBeenCalled();
	});
});
