# Brainstorm: a second "alpha / matte" sleeve image

_Status: brainstorm, not a spec. Written on the `claude/photo-generation-issues` branch to think through whether the tooling we just built opens up generating a transparent, true-edged version of each record alongside the square hero._

## The idea

Today each record produces one master: a **2000² square** where the sleeve is warped edge-to-edge to fill the canvas (`professional/{uuid}.webp`). It's clean and consistent, and it's great as a grid tile / hero.

The proposal is a **second output**: a transparent PNG/WebP of the same sleeve that

1. keeps the **true, physical edges** — slightly-off-square, worn corners, the real outline rather than a perfect rectangle, and
2. **adds breathing room** around the sleeve so those edges aren't clipped, floating on transparency (optionally with a soft contact shadow),

…like the reference the physical sleeve reads as an object sitting in space, not a texture cropped to a box.

The good news: we're closer to this than it looks. The bad news (and the interesting part): our square pipeline is specifically engineered to **destroy** the thing the matte wants to keep. That tension is the whole design problem, and it's worth being explicit about it before picking an approach.

---

## What we already have (≈80% of the plumbing)

Everything the matte needs on the storage/encode/serve side already exists, because the square pipeline was built RGBA-with-alpha throughout:

- **The pipeline is alpha-native end to end.** `reframeFromCorners` → `warpToSquare` → `padToCanvas` → `autoTone` all operate on RGBA buffers, sampling **transparent black outside bounds** (`sampleBilinear`, `photo-processing.ts:86`). We PNG-encode with alpha (`encodePng`, `professional.ts:99`) and the Images binding canonicalises to **webp-with-alpha**. Nothing assumes an opaque canvas.
- **Transparent margin is already a first-class concept.** `reframeFromCorners` takes both `canvasSize` and `contentSize`; `padToCanvas` centres the warped content on a larger transparent square, "the even gap is the transparent margin" (`photo-processing.ts:223`). `autoTone`'s statistics are **foreground-only** (`alpha < 16` pixels are ignored, `foregroundStats:266`), so padding never skews tone. The square pipeline just happens to call it with `contentSize === canvasSize` (`professional.ts:149`) so no margin shows.
- **We have the sleeve boundary already.** The admin picks the four corners by hand (seeded by `detectSleeveCorners`), stored normalised on the row as `sleeveCornersJson`. That's a strong, human-verified prior on where the object is — the exact thing generic background removal lacks.
- **We have a live client preview harness** (`pro-preview.tsx`) that runs the *same* pixel math as the server, so any new framing is previewable before it's stored.
- **We have a paid model lane** (`replicate.ts` → `runVersion` / `firstOutputUrl`, used for Real-ESRGAN Enhance) if we decide the matte needs a segmentation/matting model.

So the question isn't "can we store and serve a transparent image" — it's "**how do we get an honest true-edge silhouette**," and "how does it slot into the editor and queue."

---

## The core tension: the square warp is the enemy of true edges

Our whole philosophy (see the long comment at `professional.ts:25`) is *process the real photo, never guess the sleeve with a segmenter*. The homography does that by mapping the four picked corners onto an exact square (`warpToSquare:113`). That's perfect for the hero — and it's **exactly wrong for the matte**, because:

- forcing the 4 corners onto a rectangle makes all four edges dead-straight — the organic, not-quite-square outline the reference shows is gone by construction;
- rounded/worn physical corners get pulled to sharp 90° points;
- any real drop shadow / rim is either warped into the artwork or cropped away.

**Conclusion: the matte should not be derived from the square master.** It should come from the **capture**, using the corners as a prior but *not* as a squaring transform. Two philosophies for how far to go:

| | Keeps true edges? | New model? | Fits "no segmenter" ethos? |
|---|---|---|---|
| **A. Un-squared quad + padding** | ~partly (straight edges, real keystone) | no | yes |
| **B. Corner-anchored edge-snap** _(recommended)_ | yes (organic polyline silhouette) | no | yes |
| **C. Corner-constrained matting model** | yes (+ soft/rounded corners, hair-level) | yes (Replicate) | it's the paid-lane exception |

### A. Un-squared quad + padding (cheapest, half-honest)

Don't square. Warp the capture's corner quad into a **smaller similarity-preserving quad** centred on a larger transparent canvas — i.e. keep the sleeve's real aspect and slight keystone instead of forcing a square, then pad. Mechanically this is nearly free: it's the existing warp with `contentSize < canvasSize` and a destination quad that isn't a perfect square.

- ✅ Trivial, deterministic, reuses everything.
- ❌ Edges are still four straight lines. It reads as "a slightly tilted rectangle floating," not "a real object." Doesn't actually deliver the reference look. Good as a fast first cut / fallback, not the destination.

### B. Corner-anchored edge-snap → organic silhouette _(recommended default)_

Use the four corners to define the *approximate* boundary, then **refine each of the four edges locally against the capture pixels**: walk points along each edge and snap each to the strongest luminance gradient between sleeve and background (the same signal `detectSleeveCorners` already exploits, `photo-processing.ts:158`). The result is a **polyline silhouette** that bows and wobbles with the real edge instead of a straight line — true edges, no generative model, fully in keeping with the deterministic ethos.

Then: rasterise that polygon to an alpha mask over the **original capture pixels** (no squaring — keep the object roughly as shot, or apply only a mild deskew), feather the mask edge a touch, drop it onto a padded transparent canvas, and run the same `autoTone` / `applyPolish` we already trust.

- ✅ True edges, deterministic, no new dependency, previewable in `pro-preview.tsx`, re-runnable for free.
- ✅ The corners we already store make the refinement a *bounded* problem (snap within ±N px of a known edge) — sidestepping the "segmenter locks onto the artwork" failure mode documented at `professional.ts:31`.
- ⚠️ Needs new pixel code (edge-walk + polygon rasteriser + feather). Struggles where sleeve and background are genuinely the same tone — but there it just falls back toward the straight corner edge (i.e. degrades to option A locally), which is safe.
- ⚠️ Won't recover a *cast shadow* as part of the object — if we want a shadow it's synthesised (see below), which is arguably better anyway (consistent across the whole collection).

### C. Corner-constrained matting model (highest fidelity, paid)

If we want hair-level edges, rounded-corner softness, and true feathering, run an **image-matting / background-removal model** (e.g. RMBG-2.0 / BiRefNet-class) via the existing Replicate lane, **cropped to the corner bounding box first** so the model only ever sees the flat rectangle and can't latch onto the cover's depicted subject. Composite the returned alpha over the (optionally mild-deskewed) capture, pad, tone.

- ✅ Best-looking edges; handles soft corners and subtle rim/shadow.
- ❌ Paid + async (same cost/latency profile as Enhance), and reintroduces a model we deliberately removed — justified only if B's edges look too "cut-out." Pinned-version + crop-to-ROI keeps it honest.
- 💡 Natural framing: make it the matte's **"Enhance"** — ship B for free, offer C as an opt-in upgrade per record, exactly like Real-ESRGAN sits on top of the free reframe.

**Recommendation:** build **B**, keep **A** as the automatic fallback when edge-snap isn't confident, and hold **C** in reserve as a paid per-record upgrade if the free result isn't crisp enough.

---

## "Room around the edges" — already a knob

The padding requirement is the easy half. `contentSize < canvasSize` gives an even transparent margin for free. Concretely, for a 2000² canvas a ~6–8% margin means `contentSize ≈ 1760`, `canvasSize = 2000`. Worth exposing as a single `matteMargin` param (default ~0.07) alongside the existing reframe knobs, so the admin can dial breathing room in the live preview.

## Optional: a synthesised contact shadow

The reference's "floating object" feel comes largely from a soft shadow. Rather than trying to recover the real one, **synthesise** one deterministically from the alpha mask: blur + offset the silhouette, tint it, lay it under the sleeve on the transparent canvas. Consistent across the whole collection, and a clean on/off knob. Keep it a separate layer so consumers who want a *pure* cutout (compositing onto their own background) can request the shadow-less version.

---

## Storage / serving / schema

Mirror the square pipeline's conventions so this stays boring:

- **R2 prefix:** store under `alpha/{uuid}.webp` (webp-with-alpha; falls back to PNG only if a consumer needs guaranteed lossless alpha). Served by the existing catch-all `api/photos.$.ts` — no new route needed.
- **New DB column:** `professionalAlphaKey` on the record row (sibling to `professionalImageKey`, `schema.ts:75`). Optionally `matteParamsJson` if the margin/shadow knobs diverge from the tone knobs; otherwise fold them into `professionalParamsJson`.
- **Format note:** webp alpha is well-supported and small; the square pipeline already emits it, so no new encode path. Keep quality ~92 to match.

## How it slots into the editor + queue

- **Same corners, second output.** The matte reuses `sleeveCornersJson` — no second corner-pick. Applying corners can produce *both* the square and the matte in one pass (both are free under option B), or the matte can be a separate toggle in the editor.
- **Preview:** extend `pro-preview.tsx` to render the matte variant (transparent checkerboard behind it) so the admin sees edges + margin + shadow live before Apply.
- **Queue:** `professionalPipeline` (`professional.ts:269`) already decodes the capture once and resolves corners; adding a matte pass there means auto-on-capture generates both. Guard it behind the same approval/enhanced state machine so a matte re-run never clobbers an approved cover.
- **Remove:** extend `clearProfessional` to also delete `alpha/…` and null `professionalAlphaKey`.

---

## Rough cost / effort read

- **Padding + un-squared quad (A):** hours. Pure reuse of existing framing.
- **Edge-snap silhouette (B):** the real work — a focused chunk of new, unit-testable pixel math (edge-walk, polygon rasterise, feather) plus preview wiring. This is the recommended MVP and it's **free at runtime** (no model), so it re-runs on every corner nudge like the reframe does.
- **Synthesised shadow:** small, isolated, optional.
- **Matting model (C):** small integration (we have the Replicate lane) but **paid + async**; defer until we've seen B's output.

## Open questions for you

1. **How "true" is true enough?** Is option B's deterministic edge-snap the look you want, or are you really after the soft, rounded-corner, faint-shadow realism that only a matting model (C) gives? That decides whether we can stay model-free.
2. **Shadow: real-feeling synthesised shadow, or a clean transparent cutout** (or both variants stored)?
3. **One artifact or two?** Should Apply always emit both square + matte, or is the matte an explicit opt-in per record?
4. **Where does the matte get used?** (Detail hero? OG images? Downloadable asset?) The intended surface affects margin defaults, whether a shadow is baked in, and whether we need a shadow-less pure-cutout variant.
5. **Deskew the matte or leave it as-shot?** Fully un-warped keeps 100% of the true edge but inherits the capture's perspective; a *mild* deskew (rotate-to-level without squaring) is a nice middle ground.
