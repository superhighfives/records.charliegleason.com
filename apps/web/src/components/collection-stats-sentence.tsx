import { type ReactNode, useMemo } from "react";
import { collectionStats, type StatsRecord } from "#/lib/collection-stats";
import { numberToWords } from "#/lib/number-to-words";

/**
 * A stat — upright, and transparent so the sentence's yellow-to-white
 * gradient shows through it (see `.stats-sentence` in styles.css).
 */
function S({ children }: { children: ReactNode }) {
	return <span className="stats-highlight not-italic">{children}</span>;
}

/**
 * The footer's sign-off: one long sentence built from the collection itself
 * — oldest and newest, coloured vinyl, sevens and tens, the most-collected
 * artist, how many have notes. Each clause only appears if its stat is
 * worth saying (no "zero are sevens"), and the clauses are joined with
 * semicolons and a final "and", so the sentence reads naturally whatever
 * the data turns out to be.
 */
export function CollectionStatsSentence({
	records,
}: {
	records: StatsRecord[];
}) {
	const stats = useMemo(() => collectionStats(records), [records]);
	const words = (n: number) => numberToWords(n);

	const clauses: ReactNode[] = [];
	if (stats.oldest) {
		clauses.push(
			<>
				the oldest is <S>{stats.oldest.title}</S> by{" "}
				<S>{stats.oldest.artist}</S>, from <S>{stats.oldest.year}</S>
				{stats.newestYear && stats.newestYear !== stats.oldest.year ? (
					<>
						, and the newest is from <S>{stats.newestYear}</S>
					</>
				) : null}
			</>,
		);
	}
	if (stats.coloured > 0) {
		clauses.push(
			<>
				<S>{words(stats.coloured)}</S> {stats.coloured === 1 ? "is" : "are"} on
				coloured vinyl
				{stats.topColour && stats.coloured > 1 ? (
					<>
						, mostly <S>{stats.topColour.toLowerCase()}</S>
					</>
				) : null}
			</>,
		);
	}
	if (stats.sevens > 0 || stats.tens > 0) {
		const parts: ReactNode[] = [];
		if (stats.sevens > 0)
			parts.push(
				<>
					<S>{words(stats.sevens)}</S>{" "}
					{stats.sevens === 1 ? "is a seven" : "are sevens"}
				</>,
			);
		if (stats.tens > 0)
			parts.push(
				<>
					<S>{words(stats.tens)}</S>{" "}
					{stats.tens === 1 ? "is a ten" : "are tens"}
				</>,
			);
		clauses.push(
			parts.length === 2 ? (
				<>
					{parts[0]} and {parts[1]}
				</>
			) : (
				parts[0]
			),
		);
	}
	if (stats.multiDisc > 1) {
		clauses.push(
			<>
				<S>{words(stats.multiDisc)}</S> stretch across more than one disc
			</>,
		);
	}
	if (stats.topArtist) {
		clauses.push(
			<>
				<S>{stats.topArtist.name}</S> turns up more than anyone,{" "}
				<S>{words(stats.topArtist.count)}</S> times
			</>,
		);
	}
	if (stats.withNotes > 0) {
		clauses.push(
			<>
				<S>{words(stats.withNotes)}</S> come with notes, if you've got the time
			</>,
		);
	}

	return (
		<p className="stats-sentence max-w-6xl font-serif text-3xl font-medium tracking-tight text-pretty text-muted-foreground italic sm:text-4xl lg:text-6xl lg:leading-[1.1]">
			Well, that was all <S>{words(stats.total)}</S>
			{clauses.length > 0 ? ": " : "."}
			{clauses.map((clause, i) => (
				// biome-ignore lint/suspicious/noArrayIndexKey: clause order is fixed
				<span key={i}>
					{i > 0 && (i === clauses.length - 1 ? "; and " : "; ")}
					{clause}
				</span>
			))}
			{clauses.length > 0 ? "." : null}
		</p>
	);
}
