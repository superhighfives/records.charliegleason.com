import { queryOptions } from "@tanstack/react-query";

import { getFilterSettings } from "#/lib/settings";

/** TanStack Query options for the public filter strip's config. */
export const filterSettingsQueryOptions = queryOptions({
	queryKey: ["settings", "filters"] as const,
	queryFn: () => getFilterSettings(),
});
