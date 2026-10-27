/** Where one record lands in the packed wall. */
export type Placement = { col: number; row: number; span: number };

/**
 * Packs items into `cols` columns the way CSS `grid-auto-flow: dense` does —
 * which is what the DOM grid uses, so the wall puts the same records in the
 * same places. Each item claims a `span`×`span` square; every item takes the
 * first free spot scanning row by row from the top, so a gap a 2×2 left
 * behind gets backfilled by later 1×1s. A span wider than the grid is
 * clamped to it.
 *
 * Also returns `cells`, the occupant index for every cell (row-major,
 * `rows * cols`, -1 where empty), so callers can ask "what's at this row and
 * column" without searching.
 */
export function packDense(
	spans: readonly number[],
	cols: number,
): { placements: Placement[]; rows: number; cells: Int32Array } {
	const taken: boolean[] = [];
	const isFree = (row: number, col: number, span: number) => {
		if (col + span > cols) return false;
		for (let r = row; r < row + span; r++) {
			for (let c = col; c < col + span; c++) {
				if (taken[r * cols + c]) return false;
			}
		}
		return true;
	};

	const placements: Placement[] = [];
	let rows = 0;
	for (const wanted of spans) {
		const span = Math.max(1, Math.min(wanted, cols));
		let row = 0;
		let col = 0;
		for (;;) {
			if (isFree(row, col, span)) break;
			col++;
			if (col >= cols) {
				col = 0;
				row++;
			}
		}
		for (let r = row; r < row + span; r++) {
			for (let c = col; c < col + span; c++) taken[r * cols + c] = true;
		}
		placements.push({ col, row, span });
		rows = Math.max(rows, row + span);
	}

	const cells = new Int32Array(rows * cols).fill(-1);
	placements.forEach(({ col, row, span }, i) => {
		for (let r = row; r < row + span; r++) {
			for (let c = col; c < col + span; c++) cells[r * cols + c] = i;
		}
	});
	return { placements, rows, cells };
}
