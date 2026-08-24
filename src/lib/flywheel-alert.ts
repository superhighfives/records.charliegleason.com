import { env } from "cloudflare:workers";
import * as Sentry from "@sentry/tanstackstart-react";
import { isNotNull } from "drizzle-orm";

import { getDb } from "#/db";
import { records } from "#/db/schema";
import manifest from "../../ml/labels_manifest.json";

/**
 * "Time to retrain the corner detector" email nudge.
 *
 * The learned corner model (`ml/`, `crates/sleeve-corner-net`) is trained offline on the
 * admin's saved crops — every manual nudge-and-save is a new label. There's no value
 * retraining until enough corrections have accrued. The retrain itself IS automated (see
 * `.github/workflows/retrain-corners.yml`, dispatched either weekly or the moment a save
 * crosses threshold via `retrain-dispatch.ts`) — but a model swap stays human-reviewed via PR,
 * never silent. This weekly cron just *counts* how many labels have changed since the model
 * was last trained and emails once the drift crosses {@link RETRAIN_THRESHOLD}, as a fallback
 * in case the on-save dispatch didn't fire (e.g. `GITHUB_DISPATCH_TOKEN` unset).
 *
 * Baseline = `ml/labels_manifest.json`, a per-record FNV-1a hash of each stored band, committed
 * alongside the model by `train.py`. Comparing live D1 to it counts added + changed labels;
 * committing a fresh manifest with the next model resets the baseline automatically, so there's
 * no separate "last notified" state to keep — the weekly cadence is the dedup.
 */
export const RETRAIN_THRESHOLD = 10;

const FROM = { name: "Records", email: "digest@charliegleason.com" };
const TO = "hi@charliegleason.com";

async function sendDriftEmail(subject: string, html: string): Promise<boolean> {
	if (!env.EMAIL) return false;
	await env.EMAIL.send({ from: FROM, to: TO, subject, html });
	return true;
}

// FNV-1a (32-bit). Matches `train.py`'s `_fnv1a` byte-for-byte on the ASCII JSON that
// `sleeveCornersJson` always is (digits, brackets, `.`, `,`, `-`, `e`), so hashes are
// comparable across the Python-generated manifest and this Worker.
export function fnv1a(s: string): number {
	let h = 2166136261;
	for (let i = 0; i < s.length; i++) {
		h ^= s.charCodeAt(i);
		h = Math.imul(h, 16777619) >>> 0;
	}
	return h >>> 0;
}

/** Count labels added or changed since the model's training snapshot. */
export async function countDrift(): Promise<{
	added: number;
	changed: number;
}> {
	const db = getDb(env.DB);
	const rows = await db
		.select({ id: records.id, band: records.sleeveCornersJson })
		.from(records)
		.where(isNotNull(records.sleeveCornersJson));
	const base = manifest.labels as Record<string, number>;
	let added = 0;
	let changed = 0;
	for (const { id, band } of rows) {
		if (!band) continue;
		const prev = base[String(id)];
		if (prev === undefined) added++;
		else if (prev !== fnv1a(band)) changed++;
	}
	return { added, changed };
}

/**
 * Weekly check (src/server.ts cron): email if ≥ {@link RETRAIN_THRESHOLD} corner labels have
 * drifted from the trained baseline. Returns what it found so the caller/tests can assert.
 */
export function runFlywheelCheck(): Promise<{
	added: number;
	changed: number;
	emailed: boolean;
}> {
	return Sentry.startSpan({ name: "runFlywheelCheck" }, async () => {
		const { added, changed } = await countDrift();
		const drift = added + changed;
		if (drift < RETRAIN_THRESHOLD) return { added, changed, emailed: false };
		const emailed = await sendDriftEmail(
			`${drift} sleeve crops changed — retrain the corner detector?`,
			`<p><strong>${drift}</strong> sleeve-corner labels have changed since the ` +
				`corner model was last trained (<strong>${added}</strong> new, ` +
				`<strong>${changed}</strong> corrected).</p>` +
				`<p>Worth a retrain when you have ~3 minutes — see the flywheel steps in ` +
				`<code>ml/README.md</code>. Committing the new model resets this counter.</p>`,
		);
		return { added, changed, emailed };
	});
}

/**
 * Emailed by {@link maybeTriggerRetrain} (`retrain-dispatch.ts`) right after it fires the
 * retrain-corners `workflow_dispatch`, so a same-day automatic retrain doesn't happen
 * silently — {@link runFlywheelCheck}'s weekly email only fires as a fallback for when this
 * on-save path didn't (e.g. `GITHUB_DISPATCH_TOKEN` unset).
 */
export function notifyRetrainDispatched(
	added: number,
	changed: number,
): Promise<boolean> {
	return Sentry.startSpan({ name: "notifyRetrainDispatched" }, () => {
		const drift = added + changed;
		return sendDriftEmail(
			`Retraining the corner detector now — ${drift} labels changed`,
			`<p>A corner-label save just crossed the retrain threshold, so the ` +
				`<strong>retrain-corners</strong> GitHub Actions workflow was kicked off ` +
				`automatically (<strong>${added}</strong> new, <strong>${changed}</strong> ` +
				`corrected — ${drift} total).</p>` +
				`<p>It'll open a PR with the new model + metrics for review once it finishes ` +
				`(~2-4h). See <code>ml/README.md</code> for the flywheel details.</p>`,
		);
	});
}
