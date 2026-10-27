import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { lazy, Suspense, useCallback, useEffect, useState } from "react";

import type { PublicRecord } from "#/lib/records";
import { recordIdParam } from "#/lib/records-path";
import { publicRecordsQueryOptions } from "#/lib/records-queries";

/**
 * Prototype: the collection grid as a lit 3D wall (three.js via React Three
 * Fiber + drei) — parallax, a cursor spotlight with shadows, dust, records
 * lifting off the wall. Exploratory, not linked from the main page. The
 * scene is lazy-loaded and client-only; `?stats` shows a frame meter.
 */
export const Route = createFileRoute("/wall")({
	loader: ({ context }) =>
		context.queryClient.ensureQueryData(publicRecordsQueryOptions),
	head: () => ({ meta: [{ title: "Wall · Records" }] }),
	component: WallPage,
});

const WallScene = lazy(() => import("#/components/wall/wall-scene"));

function WallPage() {
	const { data: allRecords } = useSuspenseQuery(publicRecordsQueryOptions);
	const [records] = useState(() =>
		allRecords.filter(
			(r) => r.professionalStatus === "approved" && r.professionalImageKey,
		),
	);
	const navigate = useNavigate();
	const [active, setActive] = useState<number | null>(null);
	const [contentHeight, setContentHeight] = useState(0);
	const [env, setEnv] = useState<{
		background: string;
		isTouch: boolean;
		showStats: boolean;
	} | null>(null);

	useEffect(() => {
		setEnv({
			background: getComputedStyle(document.body).backgroundColor,
			isTouch: window.matchMedia("(hover: none) and (pointer: coarse)").matches,
			showStats: new URLSearchParams(window.location.search).has("stats"),
		});
	}, []);

	const open = useCallback(
		(record: PublicRecord) =>
			navigate({ to: "/records/$id", params: { id: recordIdParam(record) } }),
		[navigate],
	);

	const record = active == null ? null : records[active];

	return (
		<>
			{/* Native scroll drives the camera — this spacer is the scroll height. */}
			<div style={{ height: contentHeight }} aria-hidden />
			<div className="fixed inset-0">
				{env && records.length > 0 && (
					<Suspense fallback={null}>
						<WallScene
							records={records}
							onActiveChange={setActive}
							onOpen={open}
							onContentHeight={setContentHeight}
							background={env.background}
							isTouch={env.isTouch}
							showStats={env.showStats}
						/>
					</Suspense>
				)}
			</div>
			{/* Vignette, so the light reads as a pool in a dark room. */}
			<div
				className="pointer-events-none fixed inset-0"
				style={{
					background:
						"radial-gradient(ellipse at center, transparent 45%, rgb(0 0 0 / 0.55) 100%)",
				}}
			/>

			<Link
				to="/"
				className="fixed top-4 left-4 rounded-full border bg-background/80 px-3 py-1.5 font-mono text-muted-foreground text-xs backdrop-blur-sm hover:text-foreground"
			>
				← Grid
			</Link>

			<div
				className="pointer-events-none fixed inset-x-0 bottom-6 flex justify-center px-4 transition-opacity duration-300"
				style={{ opacity: record ? 1 : 0 }}
			>
				{record && (
					<div className="flex max-w-[calc(100%-2rem)] flex-col items-center gap-0.5 rounded-md border bg-popover/95 px-4 py-2 text-center text-popover-foreground shadow-lg">
						<p className="text-balance font-serif text-base font-medium leading-tight">
							{record.title}
						</p>
						<p className="font-mono text-muted-foreground text-xs">
							{record.artist}
							{record.year ? ` · ${record.year}` : ""}
						</p>
					</div>
				)}
			</div>
		</>
	);
}
