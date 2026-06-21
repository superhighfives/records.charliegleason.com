/**
 * The Fork (the-fork.vercel.app) — Pitchfork review scores.
 *
 * ⚠️ The Fork has no published API. The endpoint/shape below is a best-effort
 * guess and MUST be confirmed against the site's network tab, then adjusted.
 * Everything is wrapped so a wrong guess degrades gracefully (returns null) and
 * never breaks the analysis flow.
 */

const BASE = "https://the-fork.vercel.app";

export interface PitchforkScore {
	score: number;
	url: string | null;
}

export async function getPitchforkScore(
	artist: string,
	title: string,
): Promise<PitchforkScore | null> {
	try {
		const url = new URL(`${BASE}/api/search`); // TODO: confirm real endpoint
		url.searchParams.set("q", `${artist} ${title}`.trim());

		const res = await fetch(url, {
			headers: { accept: "application/json" },
		});
		if (!res.ok) return null;

		// TODO: confirm response shape. Defensive parse of common shapes.
		const data = (await res.json()) as unknown;
		const first = Array.isArray(data)
			? data[0]
			: ((data as { results?: Array<unknown> })?.results?.[0] ?? data);
		const rec = first as { score?: unknown; rating?: unknown; url?: unknown };

		const raw = rec?.score ?? rec?.rating;
		const score = raw == null ? Number.NaN : Number(raw);
		if (!Number.isFinite(score)) return null;

		return { score, url: rec?.url ? String(rec.url) : null };
	} catch {
		return null;
	}
}
