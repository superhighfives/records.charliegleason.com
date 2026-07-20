import { createContext, type ReactNode, useContext, useState } from "react";

/**
 * The collection's text-filter lives here rather than in `CollectionView`'s own
 * state because opening a record swaps the matched route (`/` ↔ `/records/$id`),
 * which remounts the view. Holding the filter in a provider mounted above the
 * router outlet (see __root.tsx) keeps what you typed as you open and close
 * records — without pushing it into the URL.
 */
const CollectionSearchContext = createContext<
	[string, (value: string) => void] | null
>(null);

export function CollectionSearchProvider({ children }: { children: ReactNode }) {
	const state = useState("");
	return (
		<CollectionSearchContext.Provider value={state}>
			{children}
		</CollectionSearchContext.Provider>
	);
}

export function useCollectionSearch(): [string, (value: string) => void] {
	const ctx = useContext(CollectionSearchContext);
	if (!ctx) {
		throw new Error(
			"useCollectionSearch must be used within a CollectionSearchProvider",
		);
	}
	return ctx;
}
