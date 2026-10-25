import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { ArrowDownIcon, ArrowUpIcon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

import { FilterStrip } from "#/components/filter-strip";
import { Button } from "#/components/ui/button";
import { Input } from "#/components/ui/input";
import { Switch } from "#/components/ui/switch";
import {
	buildFacets,
	type CollectionFacets,
	type CollectionFilters,
	decadeLabel,
	NO_FILTERS,
} from "#/lib/collection-filters";
import {
	DEFAULT_FILTER_SETTINGS,
	type FilterGroupId,
	type FilterGroupSettings,
	type FilterSettings,
	stripGroups,
} from "#/lib/filter-settings";
import { publicRecordsQueryOptions } from "#/lib/records-queries";
import { saveFilterSettings } from "#/lib/settings";
import { filterSettingsQueryOptions } from "#/lib/settings-queries";
import { cn } from "#/lib/utils";

export const Route = createFileRoute("/admin/filters")({
	component: FiltersPage,
});

/** What each group filters on, for the admin's benefit. */
const GROUP_HINTS: Record<FilterGroupId, string> = {
	decade: "Release year, bucketed by decade.",
	size: 'Physical size — 12", 10", 7".',
	color: "Vinyl colour, with its palette swatch.",
	notes: "A single toggle: records with notes written up.",
};

/**
 * Control over the public collection's filter strip: turn groups on and off,
 * reorder and rename them, set how many records a chip needs before it's
 * offered, and hide individual chips. Edits are a local draft with a live
 * preview of the real strip (clickable, against the real public records)
 * until saved.
 */
function FiltersPage() {
	const queryClient = useQueryClient();
	const { data: saved } = useQuery(filterSettingsQueryOptions);
	const { data: records = [] } = useQuery(publicRecordsQueryOptions);
	const [draft, setDraft] = useState<FilterSettings | null>(null);
	const [previewFilters, setPreviewFilters] =
		useState<CollectionFilters>(NO_FILTERS);

	// Seed the draft once the saved config arrives.
	useEffect(() => {
		if (saved && !draft) setDraft(saved);
	}, [saved, draft]);

	const facets = useMemo(() => buildFacets(records), [records]);
	const dirty =
		!!draft && !!saved && JSON.stringify(draft) !== JSON.stringify(saved);

	const saveMutation = useMutation({
		mutationFn: (data: FilterSettings) => saveFilterSettings({ data }),
		onSuccess: (_, data) => {
			queryClient.setQueryData(filterSettingsQueryOptions.queryKey, data);
			toast.success("Filters saved.");
		},
		onError: () => toast.error("Couldn't save the filters."),
	});

	if (!draft) {
		return <p className="p-4 text-sm text-muted-foreground">Loading…</p>;
	}

	const updateGroup = (
		id: FilterGroupId,
		patch: Partial<FilterGroupSettings>,
	) =>
		setDraft({
			groups: draft.groups.map((g) => (g.id === id ? { ...g, ...patch } : g)),
		});
	const move = (index: number, by: -1 | 1) => {
		const groups = [...draft.groups];
		const [g] = groups.splice(index, 1);
		groups.splice(index + by, 0, g);
		setDraft({ groups });
	};
	const shown = new Set(stripGroups(facets, draft).map((g) => g.id));

	return (
		<div className="mx-auto w-full max-w-4xl space-y-6 p-4">
			<header className="flex flex-wrap items-start justify-between gap-3">
				<div className="space-y-1">
					<h1 className="text-lg font-semibold">Filters</h1>
					<p className="text-sm text-muted-foreground">
						What the public collection's filter strip offers, in order.
					</p>
				</div>
				<div className="flex gap-2">
					<Button
						type="button"
						variant="ghost"
						onClick={() => setDraft(DEFAULT_FILTER_SETTINGS)}
					>
						Reset to defaults
					</Button>
					<Button
						type="button"
						variant="outline"
						disabled={!dirty}
						onClick={() => saved && setDraft(saved)}
					>
						Discard
					</Button>
					<Button
						type="button"
						disabled={!dirty || saveMutation.isPending}
						onClick={() => saveMutation.mutate(draft)}
					>
						{saveMutation.isPending ? "Saving…" : "Save"}
					</Button>
				</div>
			</header>

			<section className="space-y-2">
				<h2 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
					Preview
				</h2>
				<div className="overflow-hidden rounded-md border border-border px-4 pt-4 [&_.filter-strip]:mb-4">
					<FilterStrip
						records={records}
						countRecords={records}
						filters={previewFilters}
						settings={draft}
						onChange={setPreviewFilters}
					/>
					{shown.size === 0 && (
						<p className="pb-4 text-sm text-muted-foreground">
							No filters will show.
						</p>
					)}
				</div>
			</section>

			<ol className="space-y-3">
				{draft.groups.map((g, i) => (
					<li key={g.id} className="rounded-md border border-border p-4">
						<div className="flex flex-wrap items-center gap-3">
							<div className="flex flex-col">
								<Button
									type="button"
									variant="ghost"
									size="icon-sm"
									className="size-6"
									aria-label={`Move ${g.label} up`}
									disabled={i === 0}
									onClick={() => move(i, -1)}
								>
									<ArrowUpIcon className="size-3.5" />
								</Button>
								<Button
									type="button"
									variant="ghost"
									size="icon-sm"
									className="size-6"
									aria-label={`Move ${g.label} down`}
									disabled={i === draft.groups.length - 1}
									onClick={() => move(i, 1)}
								>
									<ArrowDownIcon className="size-3.5" />
								</Button>
							</div>
							<Switch
								checked={g.enabled}
								onCheckedChange={(enabled) => updateGroup(g.id, { enabled })}
								aria-label={`Show ${g.label}`}
							/>
							<div className="min-w-0 flex-1">
								<Input
									value={g.label}
									maxLength={40}
									onChange={(e) => updateGroup(g.id, { label: e.target.value })}
									aria-label="Heading"
									className="h-8 max-w-56 font-medium"
								/>
								<p className="mt-1 text-xs text-muted-foreground">
									{GROUP_HINTS[g.id]}
									{g.enabled && !shown.has(g.id) && (
										<span className="text-amber-600 dark:text-amber-400">
											{" "}
											Hidden right now — fewer than{" "}
											{g.id === "notes" ? "one chip" : "two chips"} pass the
											rules below.
										</span>
									)}
								</p>
							</div>
							<label
								htmlFor={`min-count-${g.id}`}
								className="flex items-center gap-2 text-xs text-muted-foreground"
							>
								Min records
								<Input
									id={`min-count-${g.id}`}
									type="number"
									min={1}
									max={1000}
									value={g.minCount}
									onChange={(e) =>
										updateGroup(g.id, {
											minCount: Math.max(1, Number(e.target.value) || 1),
										})
									}
									className="h-8 w-16 tabular-nums"
								/>
							</label>
						</div>
						{g.id !== "notes" && (
							<ChipToggles
								group={g}
								facets={facets}
								onChange={(hidden) => updateGroup(g.id, { hidden })}
							/>
						)}
					</li>
				))}
			</ol>
		</div>
	);
}

/**
 * Every value the collection has for a group, as toggles: click to hide or
 * show a chip. Chips under the group's minimum are dimmed and struck out —
 * they won't show either way until they reach it.
 */
function ChipToggles({
	group,
	facets,
	onChange,
}: {
	group: FilterGroupSettings;
	facets: CollectionFacets;
	onChange: (hidden: string[]) => void;
}) {
	const values: { key: string; label: string; count: number }[] =
		group.id === "decade"
			? facets.decades.map((f) => ({
					key: String(f.value),
					label: decadeLabel(f.value),
					count: f.count,
				}))
			: (group.id === "size" ? facets.sizes : facets.colors).map((f) => ({
					key: f.value,
					label: f.value,
					count: f.count,
				}));
	if (values.length === 0) return null;
	const hidden = new Set(group.hidden);

	return (
		<div className="mt-3 flex flex-wrap gap-1.5 pl-[4.75rem]">
			{values.map((v) => {
				const isHidden = hidden.has(v.key);
				const belowMin = v.count < group.minCount;
				return (
					<button
						key={v.key}
						type="button"
						aria-pressed={!isHidden}
						title={
							belowMin
								? `Needs ${group.minCount} records to show`
								: isHidden
									? "Hidden — click to show"
									: "Shown — click to hide"
						}
						onClick={() =>
							onChange(
								isHidden
									? group.hidden.filter((h) => h !== v.key)
									: [...group.hidden, v.key],
							)
						}
						className={cn(
							"inline-flex h-7 items-center gap-1.5 rounded-full border px-2.5 text-xs transition-colors",
							isHidden
								? "border-dashed border-border text-muted-foreground line-through"
								: "border-foreground/30 text-foreground hover:border-foreground",
							belowMin && "opacity-40",
						)}
					>
						{v.label}
						<span className="font-mono text-[0.625rem] tabular-nums opacity-60">
							{v.count}
						</span>
					</button>
				);
			})}
		</div>
	);
}
