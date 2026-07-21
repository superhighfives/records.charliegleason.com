# matte-container

The memory-heavy sleeve **matte** render, extracted from the Worker into a Cloudflare
Container so it runs with real RAM instead of fighting the 128 MB Worker-isolate ceiling.

## Why

The matte tail (deskew → ViTMatte → ESRGAN super-resolve → warp/feather/shadow → encode)
stacks several large RGBA buffers. In the queue consumer's 128 MB isolate a marginal run
gets OOM-killed mid-render — uncatchably, so the graceful AI→deterministic→fail fallback
never runs, the row stays `processing`, and the reaper re-enqueues it into the same wall.
That was the production matte loop (Sentry `Network connection lost.`, 100+ events).

A `standard-1` container (4 GiB) is ~32× the isolate, so the OOM disappears, and doing the
image encode/decode with **sharp/libvips** instead of the Cloudflare Images binding also
sidesteps its `9402 file too large` input limit.

## Architecture

The container is a **pure image function** — no R2, no DB, no secrets baked in:

```
Worker (queue consumer)  ──(capture bytes + band + params + token)──▶  Container
  reads capture from R2                                                 decode (sharp)
  passes REPLICATE_API_KEY per-request                                  ViTMatte (Replicate)
  writes the two WebP mattes to R2                                      ESRGAN + warp + encode
  commits the DB row       ◀────────(shadow.webp + cutout.webp)────────
```

The **pixel math is shared, not duplicated.** The container reuses the repo's pure modules
verbatim via the `#/*` alias (resolved to `../src` at bundle time), so both renderers run
byte-identical geometry:

- `src/lib/photo-processing.ts` — all the warp/mask/deskew math
- `src/lib/matte-config.ts` — the render constants + `matteOptions`
- `src/lib/matte-pixels.ts` — the AI-path mask helpers
- `src/lib/reframe-params.ts`, `src/lib/sleeve-corners.ts` — shared types

Only the binding-coupled surface is reimplemented here (`src/image-io.ts`): `decodeRgba` /
`encodePng` / `encodeWebp` / `upscaleImage` on sharp, and a token-taking Replicate client
(`src/replicate.ts`). `src/matte.ts` is a near-line-for-line port of `src/lib/matte.ts`'s
`matteAI` / `matteFromBand`.

## Build & run

```sh
cd containers/matte
bun install          # sharp (runtime) + esbuild (build)
bun run build        # esbuild → dist/server.js (bundles the shared #/lib code, sharp external)
bun run start        # node dist/server.js  (listens on :8080)
```

The Docker image (`Dockerfile`) is multi-stage; its build context is the **repo root**
(`image_build_context: "."` in wrangler.jsonc) so the bundle step can reach `src/lib`.

### HTTP contract (internal — only the `MatteContainer` DO calls it)

- `GET /health` → `200 ok`
- `POST /matte` — JSON `{ capture: base64, band, params, mode: "ai"|"deterministic", replicateToken? }`
  → JSON `{ source, shadow: base64(webp), cutout: base64(webp) }`

## Remaining Worker-side wiring (the follow-up)

The container app + shared refactor are complete and typecheck/test green. Not yet landed
(needs Docker to build the image + a deploy to validate, and preview-env config decisions):

1. `bun add @cloudflare/containers`; add a `MatteContainer extends Container` class and a
   `renderMatteInContainer()` client (`src/lib/matte-container.ts`), export the class from
   `src/server.ts`.
2. wrangler.jsonc: `containers` (`instance_type: standard-1`, `max_instances: 3`,
   `image_build_context: "."`), the `MATTE_CONTAINER` durable-object binding, and a
   `new_sqlite_classes` migration — in **both** the top-level and `env.preview` blocks
   (bindings aren't inherited). Run `wrangler types`.
3. Gate the matte stage on a `MATTE_RENDERER` var (`"worker"` default → `"container"`):
   in `professional-pipeline.ts`, `renderAiMatte` / `renderDeterministicMatte` call the
   container when enabled, else the current in-isolate path. Keep the deterministic fallback
   as the safety net.
4. Validate on preview, cut prod over, then retire the AI/deterministic isolate-split hack.
