import { useHotkeys } from "@tanstack/react-hotkeys";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronRight, RedoIcon, UploadIcon } from "lucide-react";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";

import { Pager } from "#/components/pager";
import { Button } from "#/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "#/components/ui/dialog";
import type { Record } from "#/db/schema";
import {
	amazonImageUrl,
	type PurchasePair,
	pairPurchasesToRecords,
	parseAmazonOrderHistory,
} from "#/lib/amazon-csv";
import { displayCoverKey } from "#/lib/cover";
import { enqueueAmazonResolve } from "#/lib/records";
import { recordsQueryOptions } from "#/lib/records-queries";
import { cn } from "#/lib/utils";

/**
 * Import an Amazon "Request My Data" order-history export and use it to pin the
 * exact *pressing* on records you own. Parses the CSV client-side, pairs each music
 * purchase with a record still missing a release (by title), then — on "Queue
 * lookups" — hands each pairing to the background `resolve-asin` queue, which reads
 * the barcode off the product page and pins the matching Discogs pressing. The slow
 * per-ASIN web search runs server-side, so the modal never blocks; pressings fill
 * in on the records over the next few minutes. Only ever touches records you
 * already have, and never overwrites a pressing that's already pinned.
 */
export function AmazonImportDialog({
	open,
	onOpenChange,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
}) {
	const queryClient = useQueryClient();
	const recordsQuery = useQuery(recordsQueryOptions);
	// Records that have a matched album (master) but no pinned pressing. Requiring
	// a master keeps the pool to records with a *canonical* artist/title (from
	// Discogs) rather than a raw capture read — so a match is trustworthy, and
	// junk-title unmatched records can't fuzzy-match unrelated purchases. A record
	// that already has a pinned pressing is left alone, and so is one with a
	// resolve-asin job already queued — otherwise re-uploading the same CSV before
	// the background queue drains would re-offer purchases that are already in
	// flight (see the header queue menu for their live status).
	const needRelease = useMemo(
		() =>
			(recordsQuery.data ?? []).filter(
				(r) =>
					r.masterId != null &&
					r.discogsId == null &&
					r.amazonResolveStatus !== "queued",
			),
		[recordsQuery.data],
	);

	const fileRef = useRef<HTMLInputElement>(null);
	const [pairs, setPairs] = useState<Array<PurchasePair<Record>> | null>(null);
	// How many parsed purchases matched no record (books, non-collection,
	// already-pinned, or no master yet) — surfaced so the count isn't mistaken
	// for a failure.
	const [unpaired, setUnpaired] = useState(0);
	const [skipped, setSkipped] = useState<Set<string>>(new Set());
	const [parseError, setParseError] = useState<string | null>(null);
	const [queued, setQueued] = useState(false);
	// Index into `pairs` of the pairing whose Amazon-vs-yours comparison modal is
	// open, if any — an index (rather than the pair itself) so Previous/Next can
	// step through the list without needing to look the current one back up.
	const [compareIndex, setCompareIndex] = useState<number | null>(null);

	// Reset-on-open, not a `key`-driven remount: the Dialog needs to stay mounted
	// through its own close animation, so swapping `key`s on `open` would tear the
	// content down (and its transition) the instant `open` flips to false, before
	// Radix gets to animate it out.
	useEffect(() => {
		if (open) {
			setPairs(null);
			setUnpaired(0);
			setSkipped(new Set());
			setParseError(null);
			setQueued(false);
			setCompareIndex(null);
		}
	}, [open]);

	function toggleSkip(asin: string) {
		setSkipped((s) => {
			const next = new Set(s);
			if (next.has(asin)) next.delete(asin);
			else next.add(asin);
			return next;
		});
	}

	async function handleFile(file: File | undefined) {
		if (!file) return;
		setParseError(null);
		const items = parseAmazonOrderHistory(await file.text());
		if (items.length === 0) {
			setParseError(
				"No music orders found in that file. Make sure it's the Retail.OrderHistory.csv from Amazon's data export.",
			);
			setPairs([]);
			return;
		}
		const matched = pairPurchasesToRecords(items, needRelease);
		setPairs(matched);
		setUnpaired(items.length - matched.length);
	}

	const active = (pairs ?? []).filter((p) => !skipped.has(p.item.asin));

	const compare = compareIndex != null ? (pairs?.[compareIndex] ?? null) : null;
	const hasPrev = compareIndex != null && compareIndex > 0;
	const hasNext =
		compareIndex != null && pairs != null && compareIndex < pairs.length - 1;

	// ← / → step through the pairings without closing the comparison modal,
	// matching the record editor's pager. Disabled once nothing's open so the
	// arrows don't hijack the file picker or the row list behind it.
	useHotkeys(
		[
			{
				hotkey: "ArrowLeft",
				callback: () => hasPrev && setCompareIndex((i) => (i ?? 0) - 1),
			},
			{
				hotkey: "ArrowRight",
				callback: () => hasNext && setCompareIndex((i) => (i ?? 0) + 1),
			},
		],
		{ enabled: compare != null },
	);

	const enqueue = useMutation({
		mutationFn: () =>
			enqueueAmazonResolve({
				data: active.map((p) => ({
					recordId: p.record.id,
					asin: p.item.asin,
					country: p.item.country,
				})),
			}),
		onSuccess: async (res) => {
			await queryClient.invalidateQueries({
				queryKey: recordsQueryOptions.queryKey,
			});
			setQueued(true);
			toast.success(
				res.queued === 1
					? "Queued 1 lookup — the pressing will appear shortly."
					: `Queued ${res.queued} lookups — pressings will appear as they resolve.`,
			);
		},
		onError: () => toast.error("Couldn't queue the lookups. Try again."),
	});

	return (
		<>
			<Dialog open={open} onOpenChange={onOpenChange}>
				<DialogContent className="max-w-2xl">
					<DialogHeader>
						<DialogTitle>Import from Amazon</DialogTitle>
						<DialogDescription>
							Upload your Amazon order history (Retail.OrderHistory.csv from{" "}
							<span className="font-medium">Request My Data</span>) to pin the
							exact pressing on records you bought — resolved from the barcode
							in the background.
						</DialogDescription>
					</DialogHeader>

					{pairs == null ? (
						<div className="space-y-3">
							<Button
								type="button"
								variant="outline"
								onClick={() => fileRef.current?.click()}
							>
								<UploadIcon className="size-4" />
								Choose CSV
							</Button>
							<input
								ref={fileRef}
								type="file"
								accept=".csv,text/csv"
								className="hidden"
								onChange={(e) => handleFile(e.target.files?.[0])}
							/>
							<p className="text-xs text-muted-foreground">
								Get the file from Amazon → Account → Request Your Information →{" "}
								<span className="font-medium">Your Orders</span> (unzip it and
								pick{" "}
								<span className="font-medium">Retail.OrderHistory.csv</span>
								). Only music purchases are read, and nothing is uploaded
								anywhere — the file is parsed here in your browser.
							</p>
							{parseError && (
								<p className="text-xs text-red-600">{parseError}</p>
							)}
						</div>
					) : queued ? (
						<p className="py-6 text-center text-sm text-muted-foreground">
							Queued — watch progress in the queue menu at the top of the admin,
							and the matched pressings will fill in on your records over the
							next few minutes.
						</p>
					) : (
						<>
							<p className="text-xs text-muted-foreground">
								{active.length} purchase{active.length === 1 ? "" : "s"} matched
								a record missing a pressing.
								{unpaired > 0 &&
									` ${unpaired} other purchase${unpaired === 1 ? "" : "s"} didn't match a record — ignored.`}
							</p>
							{pairs.length === 0 ? (
								<p className="py-4 text-center text-sm text-muted-foreground">
									None of your Amazon music purchases matched a record that
									still needs a pressing.
								</p>
							) : (
								<ul className="max-h-[360px] divide-y overflow-y-auto rounded-md border">
									{pairs.map((p, i) => {
										const isSkipped = skipped.has(p.item.asin);
										return (
											<li
												key={p.item.asin}
												className={cn(
													"flex items-center gap-2 p-2 transition-colors",
													isSkipped ? "opacity-40" : "hover:bg-accent/40",
												)}
											>
												{/* Click the pairing to compare Amazon vs your record side by
											    side; the skip control is a separate sibling button. */}
												<button
													type="button"
													onClick={() => setCompareIndex(i)}
													title="Compare Amazon vs your record"
													className="flex min-w-0 flex-1 items-center gap-2 text-left"
												>
													{/* What you bought (Amazon) → what it'll pin to (your cover). */}
													<Thumb
														src={amazonImageUrl(p.item.asin)}
														alt={`Amazon: ${p.item.title}`}
													/>
													<ChevronRight className="size-4 shrink-0 text-muted-foreground" />
													<Thumb
														src={coverSrc(p.record)}
														alt={`${p.record.artist} — ${p.record.title}`}
													/>
													<div className="min-w-0 flex-1">
														<p className="truncate text-sm font-medium">
															{p.record.artist} — {p.record.title}
														</p>
														<p className="truncate text-xs text-muted-foreground">
															Amazon: {p.item.title}
															{p.item.country ? ` · ${p.item.country}` : ""}
														</p>
													</div>
												</button>
												<Button
													type="button"
													variant="ghost"
													size="icon-sm"
													aria-label={isSkipped ? "Include" : "Skip"}
													onClick={() => toggleSkip(p.item.asin)}
												>
													<RedoIcon className="size-4" />
												</Button>
											</li>
										);
									})}
								</ul>
							)}
						</>
					)}

					{pairs != null && pairs.length > 0 && !queued && (
						<DialogFooter>
							<Button
								type="button"
								onClick={() => enqueue.mutate()}
								disabled={active.length === 0 || enqueue.isPending}
							>
								{enqueue.isPending
									? "Queuing…"
									: `Queue ${active.length} lookup${active.length === 1 ? "" : "s"}`}
							</Button>
						</DialogFooter>
					)}
				</DialogContent>
			</Dialog>

			{/* Side-by-side comparison for one pairing — bigger covers plus the
			    Amazon-vs-yours details, opened by clicking a row above. Its own
			    Dialog (stacked over the import one) so it can open/close on its own. */}
			<Dialog
				open={compare != null}
				onOpenChange={(o) => {
					if (!o) setCompareIndex(null);
				}}
			>
				<DialogContent className="max-w-2xl">
					{compare && (
						<>
							<DialogHeader>
								{/* `pr-8` clears the dialog's absolute close button, same as the
								    record editor's header pager. */}
								<div className="flex items-start justify-between gap-4 pr-8">
									<DialogTitle>
										{compare.record.artist} — {compare.record.title}
									</DialogTitle>
									<Pager
										index={compareIndex ?? -1}
										total={pairs?.length ?? 0}
										hasPrev={hasPrev}
										hasNext={hasNext}
										onPrev={() => setCompareIndex((i) => (i ?? 0) - 1)}
										onNext={() => setCompareIndex((i) => (i ?? 0) + 1)}
										noun="pairing"
									/>
								</div>
								<DialogDescription>
									What you bought on Amazon, next to the record it'll pin a
									pressing on.
								</DialogDescription>
							</DialogHeader>
							<div className="grid grid-cols-2 gap-4">
								<section className="space-y-2">
									<p className="text-xs font-medium text-muted-foreground">
										Amazon
									</p>
									<Thumb
										key={compare.item.asin}
										src={amazonImageUrl(compare.item.asin, 500)}
										alt={`Amazon: ${compare.item.title}`}
										className="aspect-square w-full"
										fit="contain"
									/>
									<dl className="space-y-1 text-sm">
										<Field label="Title">{compare.item.title}</Field>
										<Field label="Category">
											{compare.item.category ?? "—"}
										</Field>
										<Field label="Ordered">
											{compare.item.orderDate ?? "—"}
										</Field>
										<Field label="Country">{compare.item.country ?? "—"}</Field>
										<Field label="ASIN">
											<a
												href={`https://www.amazon.com/dp/${compare.item.asin}`}
												target="_blank"
												rel="noreferrer"
												className="underline underline-offset-2"
											>
												{compare.item.asin}
											</a>
										</Field>
									</dl>
								</section>
								<section className="space-y-2">
									<p className="text-xs font-medium text-muted-foreground">
										Your record
									</p>
									<Thumb
										key={compare.record.id}
										src={coverSrc(compare.record)}
										alt={`${compare.record.artist} — ${compare.record.title}`}
										className="aspect-square w-full"
										fit="contain"
									/>
									<dl className="space-y-1 text-sm">
										<Field label="Artist">{compare.record.artist}</Field>
										<Field label="Title">{compare.record.title}</Field>
										<Field label="Year">{compare.record.year ?? "—"}</Field>
										<Field label="Label">{compare.record.label ?? "—"}</Field>
										<Field label="Format">
											{[compare.record.format, compare.record.size]
												.filter(Boolean)
												.join(" · ") || "—"}
										</Field>
										<Field label="Genre">{compare.record.genre ?? "—"}</Field>
										<Field label="Catalog #">
											{compare.record.catno ?? "—"}
										</Field>
										<Field label="Country">
											{compare.record.country ?? "—"}
										</Field>
									</dl>
								</section>
							</div>
							<DialogFooter>
								<Button
									type="button"
									variant="outline"
									onClick={() => toggleSkip(compare.item.asin)}
								>
									{skipped.has(compare.item.asin) ? "Include" : "Skip"}
								</Button>
							</DialogFooter>
						</>
					)}
				</DialogContent>
			</Dialog>
		</>
	);
}

/** The `/api/photos` URL for a record's cover (capture photo included), or null. */
function coverSrc(record: Record): string | null {
	const key = displayCoverKey(record, { includeCapture: true });
	return key ? `/api/photos/${key}` : null;
}

/**
 * A square image that degrades to a muted box when the image is missing or fails
 * to load — Amazon has no product image for some ASINs, and a draft record may
 * have no cover yet. Defaults to the `size-10` row thumbnail; pass `className`
 * (e.g. `aspect-square w-full`) and `fit="contain"` for the larger comparison
 * covers. `key` it by src so a fresh instance clears the failed state per image.
 */
function Thumb({
	src,
	alt,
	className = "size-10",
	fit = "cover",
}: {
	src: string | null;
	alt: string;
	className?: string;
	fit?: "cover" | "contain";
}) {
	const [failed, setFailed] = useState(false);
	if (!src || failed) {
		return <div className={cn("shrink-0 rounded bg-muted", className)} />;
	}
	return (
		<img
			src={src}
			alt={alt}
			loading="lazy"
			className={cn(
				"shrink-0 rounded",
				fit === "contain" ? "object-contain" : "object-cover",
				className,
			)}
			onError={() => setFailed(true)}
		/>
	);
}

/** A label/value line in the comparison modal's details lists. */
function Field({ label, children }: { label: string; children: ReactNode }) {
	return (
		<div className="flex justify-between gap-3">
			<dt className="shrink-0 text-muted-foreground">{label}</dt>
			<dd
				className="min-w-0 truncate text-right"
				title={typeof children === "string" ? children : undefined}
			>
				{children}
			</dd>
		</div>
	);
}
