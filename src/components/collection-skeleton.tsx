import { Skeleton } from "#/components/ui/skeleton";

// Same tile count as a first paint typically shows above the fold — enough to
// fill the viewport without the grid visibly running out mid-skeleton.
const TILE_COUNT = 12;
const TILE_KEYS = Array.from({ length: TILE_COUNT }, (_, i) => `tile-${i}`);

/** One skeleton tile — shaped like a `RecordTile`: a square cover, then two text lines. */
function SkeletonTile() {
	return (
		<div className="space-y-2">
			<Skeleton className="aspect-square w-full" />
			<div className="space-y-1.5">
				<Skeleton className="h-4 w-4/5" />
				<Skeleton className="h-3.5 w-3/5" />
			</div>
		</div>
	);
}

/**
 * Route-level fallback for {@link CollectionView} (`_collection`'s
 * `pendingComponent`) — shown while the records query is still in flight (a slow
 * or cold-cache load; SSR normally has the data ready before this ever paints).
 * Mirrors the real header + grid proportions so there's no layout jump once the
 * data lands.
 */
export function CollectionSkeleton() {
	return (
		<div className="w-full mx-auto max-w-5xl px-4 py-10 sm:px-6">
			<header className="mb-10 flex flex-col gap-6 sm:flex-row sm:items-end sm:justify-between">
				<div className="flex items-center gap-4">
					<Skeleton className="size-14 shrink-0" />
					<div className="space-y-2">
						<Skeleton className="h-3 w-24" />
						<Skeleton className="h-9 w-36" />
						<Skeleton className="h-4 w-48" />
					</div>
				</div>
				<div className="flex items-center gap-2">
					<Skeleton className="h-9 w-full sm:w-64" />
					<Skeleton className="size-9 shrink-0" />
				</div>
			</header>

			<div className="grid grid-cols-2 gap-5 sm:grid-cols-3 md:grid-cols-4">
				{TILE_KEYS.map((tileKey) => (
					<SkeletonTile key={tileKey} />
				))}
			</div>
		</div>
	);
}
