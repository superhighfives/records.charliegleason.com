import { createFileRoute, Outlet, useParams } from "@tanstack/react-router";

import { CollectionView } from "#/components/collection-view";
import { parseRecordIdParam } from "#/lib/records-path";

/**
 * Pathless layout shared by `/` and `/records/$id`. It renders the one
 * `CollectionView` instance, so navigating between the grid and an open record
 * only changes this layout's `selectedId` — it does **not** unmount/remount the
 * grid. The old sibling-routes setup remounted the whole view (and every
 * `FadeImage`) on open, which read as the grid flickering. The child routes
 * (`index`, `records.$id`) now only carry loaders/redirects and render nothing.
 */
export const Route = createFileRoute("/_collection")({
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
