/**
 * Record valuation helpers (admin only). A record's value is either the
 * collector's hand-entered "confirmed" figure (`manualValue`) or, failing that,
 * the "guessed" figure sourced from Discogs (`discogsValue`). The manual value
 * always wins when present, so a vouched-for price overrides the estimate.
 */

/** The valuation fields these helpers read (kept loose so partial panel rows fit). */
type Valued = {
	manualValue?: number | null;
	discogsValue?: number | null;
};

/**
 * What a record's Discogs value is priced from: its pinned pressing, else its
 * album (master), else nothing. When this changes, the stored value is stale.
 */
export function valuationKey(record: {
	masterId: string | null;
	discogsId: string | null;
}): string | null {
	if (record.discogsId) return `release:${record.discogsId}`;
	if (record.masterId) return `master:${record.masterId}`;
	return null;
}

/** Whether a cron run at `scheduledTime` (ms) is the monthly re-price: the 1st, in UTC. */
export function isMonthlyRefreshDay(scheduledTime: number): boolean {
	return new Date(scheduledTime).getUTCDate() === 1;
}

/** The value we count for a record: manual (confirmed) if set, else the Discogs guess. */
export function effectiveValue(record: Valued): number | null {
	return record.manualValue ?? record.discogsValue ?? null;
}

/**
 * Format a money amount for display. Uses the currency's own symbol via Intl
 * (so USD → `$45.00`), falling back to a plain number + code if the currency is
 * unknown. Returns an em dash for a missing amount.
 */
export function formatMoney(
	amount: number | null | undefined,
	currency = "USD",
): string {
	if (amount == null || !Number.isFinite(amount)) return "—";
	try {
		return new Intl.NumberFormat("en-US", {
			style: "currency",
			currency,
		}).format(amount);
	} catch {
		return `${amount.toFixed(2)} ${currency}`;
	}
}

/** Parse the stored per-condition price breakdown; empty when absent/malformed. */
export function parseValueBreakdown(
	json: string | null | undefined,
): Array<{ grade: string; price: number }> {
	if (!json) return [];
	try {
		const parsed = JSON.parse(json) as Record<string, number>;
		return Object.entries(parsed)
			.filter(([, v]) => typeof v === "number" && Number.isFinite(v))
			.map(([grade, price]) => ({ grade, price }));
	} catch {
		return [];
	}
}
