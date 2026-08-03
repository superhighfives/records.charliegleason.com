import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronRight, RedoIcon, UploadIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";

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
	// that already has a pinned pressing is left alone.
	const needRelease = useMemo(
		() =>
			(recordsQuery.data ?? []).filter(
				(r) => r.masterId != null && r.discogsId == null,
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

	useEffect(() => {
		if (open) {
			setPairs(null);
			setUnpaired(0);
			setSkipped(new Set());
			setParseError(null);
			setQueued(false);
		}
	}, [open]);

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
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="max-w-2xl">
				<DialogHeader>
					<DialogTitle>Import from Amazon</DialogTitle>
					<DialogDescription>
						Upload your Amazon order history (Retail.OrderHistory.csv from{" "}
						<span className="font-medium">Request My Data</span>) to pin the
						exact pressing on records you bought — resolved from the barcode in
						the background.
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
							pick <span className="font-medium">Retail.OrderHistory.csv</span>
							). Only music purchases are read, and nothing is uploaded anywhere
							— the file is parsed here in your browser.
						</p>
						{parseError && <p className="text-xs text-red-600">{parseError}</p>}
					</div>
				) : queued ? (
					<p className="py-6 text-center text-sm text-muted-foreground">
						Queued — the matched pressings will fill in on your records over the
						next few minutes.
					</p>
				) : (
					<>
						<p className="text-xs text-muted-foreground">
							{active.length} purchase{active.length === 1 ? "" : "s"} matched a
							record missing a pressing.
							{unpaired > 0 &&
								` ${unpaired} other purchase${unpaired === 1 ? "" : "s"} didn't match a record — ignored.`}
						</p>
						{pairs.length === 0 ? (
							<p className="py-4 text-center text-sm text-muted-foreground">
								None of your Amazon music purchases matched a record that still
								needs a pressing.
							</p>
						) : (
							<ul className="max-h-[360px] divide-y overflow-y-auto rounded-md border">
								{pairs.map((p) => {
									const isSkipped = skipped.has(p.item.asin);
									return (
										<li
											key={p.item.asin}
											className={`flex items-center gap-2 p-2 ${
												isSkipped ? "opacity-40" : ""
											}`}
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
											<Button
												type="button"
												variant="ghost"
												size="icon-sm"
												aria-label={isSkipped ? "Include" : "Skip"}
												onClick={() =>
													setSkipped((s) => {
														const next = new Set(s);
														if (next.has(p.item.asin)) next.delete(p.item.asin);
														else next.add(p.item.asin);
														return next;
													})
												}
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
	);
}

/** The `/api/photos` URL for a record's cover (capture photo included), or null. */
function coverSrc(record: Record): string | null {
	const key = displayCoverKey(record, { includeCapture: true });
	return key ? `/api/photos/${key}` : null;
}

/**
 * A small square thumbnail that degrades to a muted box when the image is missing
 * or fails to load — Amazon has no product image for some ASINs, and a draft
 * record may have no cover yet.
 */
function Thumb({ src, alt }: { src: string | null; alt: string }) {
	const [failed, setFailed] = useState(false);
	if (!src || failed) {
		return <div className="size-10 shrink-0 rounded bg-muted" />;
	}
	return (
		<img
			src={src}
			alt={alt}
			loading="lazy"
			className="size-10 shrink-0 rounded object-cover"
			onError={() => setFailed(true)}
		/>
	);
}
