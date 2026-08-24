import { env } from "cloudflare:workers";
import * as Sentry from "@sentry/tanstackstart-react";

import {
	countDrift,
	notifyRetrainDispatched,
	RETRAIN_THRESHOLD,
} from "#/lib/flywheel-alert";

const OWNER = "superhighfives";
const REPO = "records.charliegleason.com";
const WORKFLOW = "retrain-corners.yml";

const ghHeaders = (token: string) => ({
	Authorization: `Bearer ${token}`,
	Accept: "application/vnd.github+json",
	"X-GitHub-Api-Version": "2022-11-28",
});

/**
 * True if a retrain is already running/queued, or an unmerged retrain PR is open.
 * Drift doesn't drop below {@link RETRAIN_THRESHOLD} until that PR merges (it resets
 * the manifest baseline), so without this check every corner save after the first
 * would re-dispatch another ~2-4h duplicate run.
 */
async function retrainAlreadyInFlight(token: string): Promise<boolean> {
	const [runsRes, prsRes] = await Promise.all([
		fetch(
			`https://api.github.com/repos/${OWNER}/${REPO}/actions/workflows/${WORKFLOW}/runs?per_page=5`,
			{ headers: ghHeaders(token) },
		),
		fetch(
			`https://api.github.com/repos/${OWNER}/${REPO}/pulls?state=open&per_page=20`,
			{
				headers: ghHeaders(token),
			},
		),
	]);
	if (runsRes.ok) {
		const body = (await runsRes.json()) as {
			workflow_runs: Array<{ status: string }>;
		};
		if (body.workflow_runs.some((r) => r.status !== "completed")) return true;
	}
	if (prsRes.ok) {
		const body = (await prsRes.json()) as Array<{ title: string }>;
		if (body.some((pr) => pr.title.startsWith("Retrain corner model")))
			return true;
	}
	return false;
}

/**
 * Called after a corner-label save ({@link reframeRecord}): if drift has already
 * crossed {@link RETRAIN_THRESHOLD}, kick the retrain-corners GitHub Actions workflow
 * immediately instead of waiting for Monday's cron. No-ops in preview/dev or if
 * `GITHUB_DISPATCH_TOKEN` isn't configured; failures are reported to Sentry, never
 * thrown — a dispatch hiccup shouldn't fail the admin's save.
 */
export function maybeTriggerRetrain(): Promise<void> {
	return Sentry.startSpan({ name: "maybeTriggerRetrain" }, async () => {
		const token = env.GITHUB_DISPATCH_TOKEN;
		if (!token || env.ENVIRONMENT !== "production") return;
		try {
			const { added, changed } = await countDrift();
			if (added + changed < RETRAIN_THRESHOLD) return;
			if (await retrainAlreadyInFlight(token)) return;
			await fetch(
				`https://api.github.com/repos/${OWNER}/${REPO}/actions/workflows/${WORKFLOW}/dispatches`,
				{
					method: "POST",
					headers: { ...ghHeaders(token), "Content-Type": "application/json" },
					body: JSON.stringify({ ref: "main" }),
				},
			);
			await notifyRetrainDispatched(added, changed);
		} catch (err) {
			Sentry.captureException(err);
		}
	});
}
