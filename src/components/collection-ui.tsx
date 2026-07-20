import {
	createContext,
	type MutableRefObject,
	type ReactNode,
	useContext,
	useMemo,
	useRef,
	useState,
} from "react";

interface CollectionUI {
	/** The grid's text filter. */
	search: string;
	setSearch: (value: string) => void;
	/**
	 * Whether the next record drawer to open should slide in. A record opened by
	 * an in-app action (click/paging) animates; one that's already open on first
	 * paint (direct navigation / SSR) appears instantly. `openRecord` sets this
	 * before navigating, and `CollectionView` reads + clears it on mount.
	 */
	animateOpenRef: MutableRefObject<boolean>;
}

/**
 * Collection UI state that must outlive the `/` ↔ `/records/$id` route swap
 * (which remounts `CollectionView`). Held in a provider mounted above the router
 * outlet (see __root.tsx): the text filter survives opening/closing a record,
 * and the open-animation intent survives the navigation that triggers the open.
 */
const CollectionUIContext = createContext<CollectionUI | null>(null);

export function CollectionUIProvider({ children }: { children: ReactNode }) {
	const [search, setSearch] = useState("");
	const animateOpenRef = useRef(false);
	const value = useMemo(
		() => ({ search, setSearch, animateOpenRef }),
		[search],
	);
	return (
		<CollectionUIContext.Provider value={value}>
			{children}
		</CollectionUIContext.Provider>
	);
}

export function useCollectionUI(): CollectionUI {
	const ctx = useContext(CollectionUIContext);
	if (!ctx) {
		throw new Error(
			"useCollectionUI must be used within a CollectionUIProvider",
		);
	}
	return ctx;
}
