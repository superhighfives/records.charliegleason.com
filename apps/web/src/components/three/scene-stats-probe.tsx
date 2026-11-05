import { useFrame, useThree } from "@react-three/fiber";
import { useEffect } from "react";
import { Vector2 } from "three";

import { sceneStats } from "./scene-stats";

/**
 * Publishes each WebGL frame's numbers to `sceneStats` for the debug HUD.
 * three resets its counters on every `render()` call, and postprocessing
 * renders several passes a frame, so the default would count only the last
 * pass: instead the counters run for the whole frame, and this reads them
 * (the previous frame's totals) and resets them first thing in the next.
 */
export function SceneStatsProbe() {
	const gl = useThree((s) => s.gl);
	useEffect(() => {
		gl.info.autoReset = false;
		return () => {
			gl.info.autoReset = true;
			sceneStats.current = null;
		};
	}, [gl]);
	useFrame(() => {
		const { render, memory, programs } = gl.info;
		const size = gl.getDrawingBufferSize(buffer);
		sceneStats.current = {
			calls: render.calls,
			triangles: render.triangles,
			geometries: memory.geometries,
			textures: memory.textures,
			programs: programs?.length ?? 0,
			width: size.x,
			height: size.y,
			dpr: Math.round(gl.getPixelRatio() * 100) / 100,
			at: performance.now(),
		};
		gl.info.reset();
	}, -100);
	return null;
}

const buffer = new Vector2();
