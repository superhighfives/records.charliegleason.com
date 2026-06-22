import { env } from "cloudflare:workers";
import * as Sentry from "@sentry/cloudflare";
import { eq } from "drizzle-orm";

import { getDb } from "#/db";
import { records } from "#/db/schema";
import { analyzeCapture } from "#/lib/analyze";

/**
 * Background analysis via a Cloudflare Queue. Capturing a record inserts a
 * `pending` row and enqueues its id here; the consumer (wired in src/server.ts)
 * runs the AI pipeline and moves the row to `review`, or `failed` after the
 * queue's retries are exhausted. The DLQ catches anything that still fails.
 */

export interface AnalyzeMessage {
	recordId: number;
}

/** `max_retries` from wrangler.jsonc — used only to label the row once retries run out. */
const MAX_RETRIES = 3;

/** Queue producer binding (typed loosely; the binding name lives in wrangler.jsonc). */
function analyzeQueue(): Queue<AnalyzeMessage> {
	return (env as unknown as { ANALYZE_QUEUE: Queue<AnalyzeMessage> })
		.ANALYZE_QUEUE;
}

/** Enqueue a captured record for background analysis. */
export async function enqueueAnalyze(recordId: number): Promise<void> {
	await analyzeQueue().send({ recordId });
}

async function processMessage(message: Message<AnalyzeMessage>): Promise<void> {
	const { recordId } = message.body;
	const db = getDb(env.DB);

	try {
		const [record] = await db
			.update(records)
			.set({ status: "processing", error: null, updatedAt: new Date() })
			.where(eq(records.id, recordId))
			.returning();

		// Deleted between enqueue and delivery — nothing to do.
		if (!record) {
			message.ack();
			return;
		}

		const result = await analyzeCapture(record);

		await db
			.update(records)
			.set({
				artist: result.artist || "Unknown artist",
				title: result.title || "Untitled",
				year: result.year,
				label: result.label,
				genre: result.genre,
				pitchforkScore: result.pitchforkScore,
				pitchforkUrl: result.pitchforkUrl,
				discogsId: result.discogsId,
				discogsUrl: result.discogsUrl,
				coverImageKey: result.coverImageKey,
				confidence: result.confidence,
				candidatesJson: JSON.stringify(result.candidates),
				status: "review",
				error: null,
				updatedAt: new Date(),
			})
			.where(eq(records.id, recordId));

		message.ack();
	} catch (err) {
		const detail = err instanceof Error ? err.message : String(err);
		// `message.attempts` is 1 on first delivery; retry until the queue's limit,
		// then give up and surface the error on the record for a manual retry.
		const willRetry = message.attempts <= MAX_RETRIES;
		console.error(
			`[queue] analyze failed for record ${recordId} (attempt ${message.attempts}, willRetry=${willRetry}): ${detail}`,
		);
		Sentry.captureException(err);

		await db
			.update(records)
			.set({
				status: willRetry ? "pending" : "failed",
				error: detail,
				updatedAt: new Date(),
			})
			.where(eq(records.id, recordId))
			.catch(() => {});

		if (willRetry) message.retry();
		else message.ack();
	}
}

/** Queue consumer entry — processes one capture per message. */
export async function handleAnalyzeBatch(
	batch: MessageBatch<AnalyzeMessage>,
): Promise<void> {
	for (const message of batch.messages) {
		await processMessage(message);
	}
}
