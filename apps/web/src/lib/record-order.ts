import type { Record } from "#/db/schema";

type RecordStatus = NonNullable<Record["status"]>;

// Float the records that still need attention to the top of the default view,
// newest first, so a capture session lands ready to review without sorting.
export const STATUS_PRIORITY: globalThis.Record<RecordStatus, number> = {
	review: 0,
	failed: 1,
	pending: 2,
	processing: 3,
	complete: 4,
};

/**
 * The collection's default order: attention-needing statuses first (review,
 * failed, …), newest first within each. Shared by the admin list and the record
 * detail pager so paging back/next through records follows the same order the
 * list itself shows. Returns a new array; never mutates the input.
 */
export function orderRecordsForReview<
	T extends Pick<Record, "status" | "createdAt">,
>(rows: readonly T[]): T[] {
	return [...rows].sort((a, b) => {
		const pa = STATUS_PRIORITY[a.status ?? "complete"];
		const pb = STATUS_PRIORITY[b.status ?? "complete"];
		if (pa !== pb) return pa - pb;
		return (b.createdAt?.getTime() ?? 0) - (a.createdAt?.getTime() ?? 0);
	});
}

// The admin list saves the ids it shows (filtered, searched and sorted) so the
// record pager steps through the same rows. Per tab, so two tabs can walk two lists.
const PAGER_ORDER_KEY = "admin-pager-order";

export function savePagerOrder(ids: readonly number[]): void {
	try {
		window.sessionStorage.setItem(PAGER_ORDER_KEY, JSON.stringify(ids));
	} catch {
		// Storage full or blocked: the pager falls back to the default order.
	}
}

export function readPagerOrder(): number[] | null {
	try {
		const parsed: unknown = JSON.parse(
			window.sessionStorage.getItem(PAGER_ORDER_KEY) ?? "null",
		);
		return Array.isArray(parsed) && parsed.every(Number.isInteger)
			? parsed
			: null;
	} catch {
		return null;
	}
}

/**
 * The record pager's order: the list's saved rows when they include `id` (the
 * record was opened from that list), else every record in the default order.
 * Deleted records drop out.
 */
export function pagerRecords<
	T extends Pick<Record, "id" | "status" | "createdAt">,
>(rows: readonly T[], savedIds: readonly number[] | null, id: number): T[] {
	if (!savedIds?.includes(id)) return orderRecordsForReview(rows);
	const byId = new Map(rows.map((r) => [r.id, r]));
	return savedIds.flatMap((i) => byId.get(i) ?? []);
}
