import { env } from "cloudflare:workers";
import { and, eq } from "drizzle-orm";
import { getDb } from "#/db";
import { records } from "#/db/schema";
import { generateMatteFromCapture } from "#/lib/matte";
import { professionalPipeline } from "#/lib/professional";
import { enqueueCaptureFirstPassMatte } from "#/lib/queue";
import { parseReframeParams } from "#/lib/reframe-params";
import { parseCornerBand, serializeCornerBand } from "#/lib/sleeve-corners";

/**
 * The free first-pass professional photo for a fresh (or replaced) capture:
 * detect the sleeve's corners, warp to a straight square, then cut the
 * deterministic matte from the same band. Ran inline in the capture POST until
 * that OOM'd: the photon pass allocates several 2048² RGBA buffers, and stacked
 * with whatever else the isolate is doing (the analyze consumer chewing through
 * the previous capture, the request's own transform output) it brushed the
 * 128 MB ceiling — reliably so in preview, where the analyze queue is always
 * busy.
 *
 * Split across TWO queue messages, mirroring the Apply pipeline's stage split
 * and for the same documented reason (see `AnalyzeRecordMessage`): the warp and
 * the ~3000² deterministic matte are each near-ceiling renders, so they never
 * share an isolate. Stage 1 (`capture-first-pass`) persists the cover + the
 * detected band, then enqueues stage 2 (`capture-first-pass-matte`), which
 * re-reads the band off the row.
 *
 * Both stages are best-effort like the inline version was, and never throw —
 * the consumer always acks. A cover failure marks the professional* track
 * `failed` (a manual re-crop retries); a matte failure just leaves the alpha
 * keys empty (the editor's Apply can regenerate).
 *
 * Every write is guarded on the inputs it was computed from (`capturePhotoKey`,
 * and for the matte the band too) still being on the row — a replace clears the
 * row and re-enqueues, so a still-in-flight (or redelivered) message for the
 * superseded capture must not stomp the fresh one's fields with stale results.
 * Same hazard the Apply pipeline documents in `AnalyzeRecordMessage`.
 */
export async function runCaptureFirstPass(recordId: number): Promise<void> {
	const db = getDb(env.DB);
	const [record] = await db
		.select()
		.from(records)
		.where(eq(records.id, recordId))
		.limit(1);
	// Deleted between enqueue and delivery, or a row with nothing to work from.
	if (!record?.capturePhotoKey) return;

	// Guard every write on the capture this run was computed from: a replace
	// swaps `capturePhotoKey` and re-enqueues, so a match on 0 rows means this
	// message is for a superseded capture and its results must be dropped.
	const sameCapture = and(
		eq(records.id, recordId),
		eq(records.capturePhotoKey, record.capturePhotoKey),
	);

	try {
		const { professionalKey, band } = await professionalPipeline(record);
		const updated = await db
			.update(records)
			.set({
				professionalImageKey: professionalKey,
				// Persist the detected seed so the editor opens pre-cropped; a later
				// Apply overwrites it with the admin's band.
				sleeveCornersJson: serializeCornerBand(band),
				// Generated, but not shown on the site until an admin approves it.
				professionalStatus: "ready",
				professionalError: null,
				updatedAt: new Date(),
			})
			.where(sameCapture)
			.returning({ id: records.id });
		// Superseded mid-render: the replace's own message regenerates everything,
		// so don't enqueue a matte cut from the old capture's band.
		if (updated.length === 0) return;
	} catch (err) {
		const detail = err instanceof Error ? err.message : String(err);
		await db
			.update(records)
			.set({
				professionalStatus: "failed",
				professionalError: `Could not generate professional photo: ${detail}`,
				updatedAt: new Date(),
			})
			.where(sameCapture)
			.catch(() => {});
		return;
	}

	// Stage 2 in its own isolate. Enqueue failure is only logged: the cover is
	// already committed, and a missing matte is the documented degraded state.
	await enqueueCaptureFirstPassMatte(recordId).catch((err) => {
		console.error("capture-first-pass: could not enqueue matte stage", err);
	});
}

/** Stage 2: the deterministic matte, cut from the band stage 1 persisted. */
export async function runCaptureFirstPassMatte(
	recordId: number,
): Promise<void> {
	const db = getDb(env.DB);
	const [record] = await db
		.select()
		.from(records)
		.where(eq(records.id, recordId))
		.limit(1);
	// Gone, or stage 1's band never landed (its failure is already on the row).
	if (!record?.capturePhotoKey || !record.sleeveCornersJson) return;

	try {
		const matte = await generateMatteFromCapture(
			record.capturePhotoKey,
			parseCornerBand(record.sleeveCornersJson),
			parseReframeParams(record.professionalParamsJson),
			{ useAi: false },
		);
		await db
			.update(records)
			.set({
				professionalAlphaKey: matte.shadowKey,
				professionalAlphaCutoutKey: matte.cutoutKey,
				professionalAlphaSource: matte.source,
				updatedAt: new Date(),
			})
			// Only land the matte if it was cut from the capture AND band still on
			// the row — a replace (new capture) or an admin Apply (new band) mid-cut
			// supersedes this result, and each regenerates its own matte.
			.where(
				and(
					eq(records.id, recordId),
					eq(records.capturePhotoKey, record.capturePhotoKey),
					eq(records.sleeveCornersJson, record.sleeveCornersJson),
				),
			);
	} catch (err) {
		// Best-effort, same as the old inline pass: a matte failure never fails
		// the capture — the cover stays, just without a matte.
		console.error(
			`capture-first-pass: matte generation failed for record ${recordId}`,
			err,
		);
	}
}
