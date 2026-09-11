import { queryOptions } from "@tanstack/react-query";

import { listColors } from "#/lib/colors";

/** TanStack Query options for the vinyl color chip list (admin combobox). */
export const colorsQueryOptions = queryOptions({
	queryKey: ["colors"] as const,
	queryFn: () => listColors(),
});
