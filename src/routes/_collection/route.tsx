import { createFileRoute, Outlet, useParams } from "@tanstack/react-router";

import { CollectionSkeleton } from "#/components/collection-skeleton";
import { CollectionView } from "#/components/collection-view";
import { parseRecordIdParam } from "#/lib/records-path";
import { publicRecordsQueryOptions } from "#/lib/records-queries";

/**
 * Pathless layout shared by `/` and `/records/$id`. It renders the one
 * `CollectionView` instance, so navigating between the grid and an open record
 * only changes this layout's `selectedId` — it does **not** unmount/remount the
 * grid. The old sibling-routes setup remounted the whole view (and every
 * `FadeImage`) on open, which read as the grid flickering. The child routes
 * (`index`, `records.$id`) now only carry loaders/redirects and render nothing.
 *
 * Owns its own `ensureQueryData` (redundant with — but a cheap cache hit
 * alongside — the child routes' own loaders) so *this* route governs the
 * pending state for `CollectionView`'s `useSuspenseQuery`: without it, the
 * layout (no loader of its own) would mount immediately and suspend on data
 * the child's loader is still fetching, with no `pendingComponent` of its own
 * to catch it.
 */
export const Route = createFileRoute("/_collection")({
	loader: ({ context }) =>
		context.queryClient.ensureQueryData(publicRecordsQueryOptions),
	pendingComponent: CollectionSkeleton,
	component: CollectionLayout,
});

function CollectionLayout() {
	// Read the record id loosely (strict: false) so this single layout serves both
	// child routes: `/` has no `id`, `/records/$id` supplies the canonical param
	// (the record route's loader has already redirected a stale slug / unknown id).
	const params = useParams({ strict: false });
	const raw = params.id;
	const selectedId = typeof raw === "string" ? parseRecordIdParam(raw) : null;

	return (
		<>
			<CollectionView selectedId={selectedId} />
			<Outlet />
		</>
	);
}
