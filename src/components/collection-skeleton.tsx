import { RecordLoading } from "#/components/spinning-record";

/**
 * Route-level fallback for {@link CollectionView} (`_collection`'s
 * `pendingComponent`) — shown while the records query is still in flight (a
 * slow or cold-cache load; SSR normally has the data ready before this ever
 * paints). Just the shared spinning-record loader, not a layout-mirroring
 * skeleton — mirroring the header/hero/grid shape read as more "loaded" than
 * the page actually was, which made the font-loading gate's brief pause (see
 * `useFontsReady` in `CollectionView`, which also reuses this component)
 * look like a layout glitch rather than a load.
 */
export function CollectionSkeleton() {
	return <RecordLoading label="Loading records…" />;
}
