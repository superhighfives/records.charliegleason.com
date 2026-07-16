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
