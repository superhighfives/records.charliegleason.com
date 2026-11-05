/**
 * The latest WebGL frame's numbers, published by a 3D scene (see
 * `SceneStatsProbe`) for the debug HUD to show. A plain object rather than
 * React state: written every frame, read once a second, and the HUD doesn't
 * need to import three to read it.
 */
export type SceneStats = {
	/** Draw calls, across every pass (postprocessing included). */
	calls: number;
	triangles: number;
	geometries: number;
	textures: number;
	programs: number;
	/** Drawing-buffer size and pixel ratio. */
	width: number;
	height: number;
	dpr: number;
	/** `performance.now()` when written, so a stale reading can be ignored. */
	at: number;
};

export const sceneStats: { current: SceneStats | null } = { current: null };
