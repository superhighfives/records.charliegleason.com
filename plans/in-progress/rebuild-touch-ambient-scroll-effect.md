---
title: Rebuild the touch ambient scroll effect (grayscale reveal + vinyl peek)
status: In Progress
created: 2026-08-12
updated: 2026-08-12
---

# Rebuild the touch ambient scroll effect

> **2026-08-12 (second update) — direction confirmed with the user.** The
> user explicitly asked to throw the iOS/mobile experience out and rebuild
> it for: silky-smooth scrolling, scroll-driven animation, and *real*
> virtualization that handles scrolling both directions. That supersedes the
> caution in the first update below — we are doing the rebuild, as a variant
> of Option B that keeps the single continuous dense grid (see "Chosen
> approach" at the bottom of this file). Desktop stays untouched.

> **2026-08-12 update — read before executing this plan.** Two commits landed
> on the branch after this plan was written (`ea030a4` "Fix touch ambient
> state freeze, colWeight plateau squash, and reduced-motion gate", `5a77d9a`
> "Reach the pinned-tile ambient reset, cover disc-mask on hover/pinned, and
> scope reduced-motion gate to animation only") that took the **opposite**
> direction from Option A below: instead of removing the disc mask and the
> cover-fade replay mechanism, they fixed further bugs in them and *extended*
> the mask to cover desktop hover/pinned too (it previously only had touch JS
> coverage — a real gap the automated PR review round 33 caught). That work
> looks sound and is landing via the PR's own review cycle, not a rebuild.
>
> **Before executing the Tasks checklist below as written** (specifically
> "remove the disc mask" / "remove `syncCoverFade`"), re-check the PR's
> current review state and commit log — the specific removal tasks may
> already be moot, or may need to be renegotiated with whoever's continuing
> that work. The root-cause diagnosis in *Context* below (content-visibility
> paint-catchup timing racing against everything trying to synchronize with
> it) is still believed accurate and worth keeping in mind even if the
> concrete Option A recommendation built on it needs revisiting — if the
> incremental fixes keep converging (narrower, more specific bugs each
> round) rather than surfacing new categories of the same race, that's real
> evidence the rebuild may no longer be necessary. Confirm with the user
> before ripping anything out either way.

## Goal

Replace the touch-only scroll-driven "ambient" effect in `CollectionGrid`
(grayscale→colour reveal, scale, and the vinyl disc's sideways peek) with
something that doesn't require another round of whack-a-mole fixes. Desktop
(the hover-driven `grid-focus-overlay` spotlight) is not in scope — it works,
leave it alone. Everything here is scoped to `isTouch` code paths in
`src/components/collection-grid.tsx`, `src/components/fade-image.tsx`, and
whatever CSS in `src/styles.css` supports them (`.vinyl-peek`, `.vinyl-disc`,
`.collection-grid[data-scrolling="true"]`).

## Context

This branch (`fix/scroll-jank-decode-content-visibility`) started as an iOS
scroll-jank fix and grew, commit by commit, into a full rewrite of the touch
ambient effect. Over roughly 30 commits it went through: a `backdrop-filter`
vignette → CSS `filter: blur()` → a pure-CSS `animation-timeline: view()`
attempt (proven non-functional on real WebKit — `Element.getAnimations()`
showed progress permanently stuck at 50%, despite `CSS.supports()` reporting
it valid) → GSAP (`quickSetter` crashed on the SVG discs specifically —
`InvalidCharacterError` from a `setAttribute('scaleX,scaleY', …)` fallback
path on real WebKit) → the current hand-rolled JS system: a scroll-driven
`requestAnimationFrame` loop that computes a trapezoid-shaped "progress"
value per tile and writes `filter`/`scale`/disc `transform` directly to the
DOM, plus a circular mask to hide the disc, plus logic to replay the cover's
fade when a tile re-enters view.

Each of those last few fixes was correctly diagnosed and fixed the specific
bug reported — but each one also opened a new corner, and the user is still
seeing artifacts after ~10 rounds of this (most recently: the disc mask
showing through as a visible grey/tinted circle on top of already-loaded
covers, and full unmasked vinyl discs flashing into view before fading back
to the correct state during fast scrolling). That pattern — fix confirmed
live, new bug appears in the next report — is the reason for this plan
rather than another patch.

### Root causes (confirmed live this session, not guesses)

1. **The vinyl disc SVG can never be covered by `content-visibility`.**
   `content-visibility: auto` implies `contain: paint`, which clips
   descendants to the containing element's own box. The disc is *designed*
   to slide sideways past the tile's edge (`.vinyl-peek` in `styles.css`) —
   putting it under `content-visibility` (directly, or via a shared ancestor
   with the cover) clips that peek dead at the tile boundary. This was tried
   and reverted early in this branch's history (see the `.vinyl-peek` module
   comment in `styles.css`, which documents the padding-reservation approach
   that was rejected for shrinking the cover to buy room). So the disc is
   permanently a *sibling*, always rendered, never skipped — while the cover
   photo sitting in front of it *is* behind `content-visibility`, and can be
   legitimately unpainted or mid-catch-up at any moment.

2. **Every cover in this collection is alpha-transparent with a ragged
   edge.** Confirmed live via Chrome DevTools (`img.src` for every sampled
   tile was `/api/photos/alpha/….webp`, `object-fit: contain`) — this is not
   a rare matte-only exception, it's the whole collection. There is no
   reliable "solid backdrop" to put behind the disc: a full-tile square
   background always left a visible sliver past the ragged edge; a circular
   mask sized to the disc's own footprint constantly showed through the
   transparent parts of *every* cover, not just occasionally. Whatever colour
   the mask is, it's visible often enough to read as a bug, not an edge case.

3. **`checkVisibility({contentVisibilityAuto: true})` answers "is this
   currently skipped," not "has this painted yet."** There is a real,
   measurable gap between an element becoming relevant again and the browser
   actually repainting it — worse under a fast fling where many tiles become
   relevant in the same burst. Every attempt to synchronize *something else*
   (a mask's visibility, a replayed fade) to that transition has been a race
   against an interval that isn't observable from JS, and every fix for one
   side of that race has exposed the other side elsewhere (mask hides the
   disc correctly, but then blocks the *legitimate* loading-state preview;
   gate it on `coverReady` instead, and the disc shows through during the
   *next* re-entry because the mask is still catching up itself).

4. **Five independent timing systems have to agree, and don't share a
   clock.** React state (`coverReady`), CSS classes/transitions (opacity,
   with different delays for the cover vs. the disc), inline style overrides
   written imperatively outside React (the ambient effect's direct
   `filter`/`scale`/`transform` writes, the mask's opacity toggle, the
   replay mechanism's opacity resets), an eased `requestAnimationFrame`
   chase loop, and `content-visibility`'s own async, browser-scheduled
   catch-up. Every bug this session has ultimately come down to two of these
   five disagreeing about what state a given tile is *actually* in, at a
   moment neither of them can directly observe the other's state.

### What's proven and should carry forward

- The distance/trapezoid-shaped progress function (`ambientProgress` in
  `collection-grid.tsx`) reads well once it's actually driving the right
  tile — the "one tile lit at a time," steep-flat-steep shape, and the
  eased chase (mirroring the desktop spotlight's own `SPOTLIGHT_EASE`
  pattern) were all explicitly requested and confirmed good. Keep the
  *shape* of the animation; the problem is entirely in how its inputs
  (cover paint state, disc visibility) are synchronized.
- `img.decode()` (not `load`/`complete`) is the correct signal for "this
  image is actually paintable" — `decoding="async"` explicitly lets the
  browser keep decoding after either of those fire, and this was a real,
  separately-confirmed bug (fresh covers jumping straight to ~70% opacity)
  independent of the content-visibility race. Keep this fix in
  `fade-image.tsx`.
- `getBoundingClientRect`-based scanning (not `IntersectionObserver`) for
  "which tiles are near the viewport" is correct and should stay — the
  observer-based versions were proven unreliable at this scale (~300
  elements) earlier in the branch.
- GSAP is not needed and should not be reintroduced for this effect (plain
  style writes do the same job without the SVG crash).

## Approach

Two real options. Recommendation: **A**, with **B** as the fallback if A's
investigation turns up a hard blocker.

### Option A (recommended): stop fighting `content-visibility`'s timing — gate the whole effect on a self-measured "settled" state

Don't try to synchronize a mask or a replay to `content-visibility`'s
opaque, unobservable catch-up. Instead, make the *whole* ambient effect
(grayscale, scale, and disc peek together, as one unit) wait for
confirmation that a tile's cover has actually painted before it's eligible
to animate at all — using the same scroll-driven scan loop that already
runs every frame, so there's exactly **one** clock, not five.

Concretely:
- Drop the disc mask entirely (`disc-mask` in `collection-grid.tsx`) — it
  exists purely to paper over the paint-catchup gap, and every colour/shape
  tried has leaked visibly through the alpha-transparent covers.
- Drop `syncCoverFade`'s replay mechanism — same reasoning; it's another
  patch for the same underlying race, on the opposite side of it.
- In the existing per-frame scan, track a tiny bit of state per tile: "has
  this tile's cover image had a real painted frame since it last became
  relevant." The cheapest reliable proxy for "actually painted, not just
  unskipped" is two consecutive `checkVisibility() === true` scan frames
  in a row (roughly two rAFs, ~32ms apart) rather than one — cheap, no new
  APIs, and this session's own diagnostics showed real catch-up lag is
  usually on that order, not the multi-hundred-ms tail a fixed timeout
  guessed at (see the abandoned `DISC_REVEAL_DELAY_MS` attempt in this
  branch's history — a flat delay wasn't reliable under load, but it also
  didn't need to be flat; two consecutive scan-confirmed frames scales with
  how fast frames are actually happening).
- Until a tile's cover is confirmed settled, the ambient effect simply
  doesn't touch it — no grayscale reveal, no disc peek, it stays at rest.
  This trades a very slightly delayed reveal on an aggressive scroll-back
  (a beat where a tile you're already centred on hasn't started animating
  yet) for *zero* chance of showing an unmasked or half-covered disc. Given
  how prominent the current bug is, this is the right trade.
- The disc's own rest-state opacity/visibility stops depending on
  `coverReady` timing tricks altogether — at rest it's simply always
  positioned exactly behind where the (eventually opaque-enough) cover sits,
  same as it already visually reads today when nothing's gone wrong; the
  "settled" gate above is what prevents it from being *asked* to peek before
  its cover is ready, which is the actual failure mode, not the disc's own
  rendering.
- Re-verify the "one tile lit at a time," crossfade, spanning-tile-decay,
  and easing behaviour still hold — those were all correct and shouldn't
  need to change, just the gating of *when* a tile is eligible to receive a
  nonzero progress value at all.

This keeps the existing single-continuous-grid architecture (no
virtualization rewrite) and is a subtractive change overall — it removes
two of the more fragile mechanisms (mask, replay) rather than adding a
third.

### Option B (fallback): real virtualization instead of `content-visibility` as pseudo-virtualization

If Option A's investigation finds that "settled" still can't be determined
reliably enough (e.g., the two-frame heuristic still races under real
device conditions the Simulator doesn't reproduce), the more invasive fix
is to stop relying on `content-visibility: auto` as a stand-in for
virtualization and actually window the grid — only mount DOM nodes (cover,
disc, everything) for tiles within some margin of the viewport, unmounting
the rest.

This fully removes the "catch-up" concept: a genuinely unmounted-then-
remounted tile has no stale paint state to race against, it just mounts
fresh with `coverReady` correctly `false` until its own `img` really loads.
It also removes the disc-hiding problem entirely, since an unmounted tile's
disc isn't rendered either.

The known objection (documented in the `CollectionGrid` module comment) is
that an earlier *batch/chunk*-based virtualization attempt left visible
gaps in the dense grid when a batch boundary fell mid-row. That's a real
problem with *chunking* records into separate grids, not necessarily with
*windowing* a single continuous grid (e.g. keeping one CSS grid, and only
conditionally rendering/unrendering individual tile children based on
scroll position, the same way this plan's Option A already scans for
relevance every frame). Worth a short spike to confirm windowing a single
grid doesn't reintroduce the gap problem before committing to this option —
that's why it's the fallback, not the first choice.

### Verification method (do this, not screenshots alone)

Screenshots and a single "looks fine" pass repeatedly gave false confidence
this session — several fixes were reported as verified and then failed
under the user's own real-device testing. Use, in order of preference:

1. **iOS Simulator + synthetic touch scroll + video, frame-by-frame.**
   `xcrun simctl io <device> recordVideo <path>.mov` while driving scroll
   with the compiled Swift CGEvent drag tool (`drag x1 y1 x2 y2 durationMs
   steps`), then `ffmpeg -vf fps=60` to extract frames and inspect them
   individually. A single screenshot after a scroll settles will not catch a
   transient artifact; the bugs here are all about what happens *during*
   the transition.
2. **Chrome DevTools with network/CPU throttling + live sampling.** Load the
   dev server with mobile emulation, throttle network (Slow 4G) and CPU
   (4x), and run a `requestAnimationFrame` sampling loop inside
   `evaluate_script` that records computed `opacity`/`checkVisibility`/etc.
   for a specific tile over ~1s, in one call (not multiple round-tripped
   calls — round-trip latency between separate tool calls is enough to miss
   the whole transition). This was what actually found the `imgOp` 0→70%
   jump and the disc-vs-cover opacity mismatch — both were invisible to
   screenshots.
3. Chrome alone (untouched, no throttling) does **not** reliably reproduce
   these bugs — several were WebKit-specific (the GSAP crash, the
   `animation-timeline: view()` non-functionality, the content-visibility
   catch-up lag under real Safari scheduling). Don't treat a clean Chrome
   pass as confirmation.

## Tasks

- [ ] Read the current `CollectionGrid`/`RecordTile` touch effect in full
      (`src/components/collection-grid.tsx`) and confirm the diagnosis above
      still matches the code as it stands.
- [ ] Remove the disc mask (`disc-mask` div, its JSX, and the
      `updateAmbientForRect` opacity toggle for it) and the `syncCoverFade`
      replay mechanism.
- [ ] Add the "settled" per-tile tracking to the existing scroll-driven scan
      (two consecutive `checkVisibility()`-true frames, or better if
      investigation finds one) and gate `ambientTick`'s progress assignment
      on it — a tile that isn't settled gets forced to progress 0 regardless
      of its natural distance-based value.
- [ ] Re-verify (Simulator + video, per the verification method above):
  - [ ] No visible disc/vinyl showing through an unloaded or mid-catch-up
        cover, under a fast fling in both directions.
  - [ ] No visible mask/backdrop artifact of any kind (there shouldn't be
        one left to show).
  - [ ] The reveal (grayscale→colour, disc peek) still looks like a single,
        continuous, eased animation — not reintroducing the original "snap"
        complaint from earlier in this branch.
  - [ ] Only one tile ever fully lit at a time; spanning tiles still decay
        smoothly rather than snapping to 0.
  - [ ] `NowShowing`'s title bar still tracks the correct centred tile
        through a fast fling.
- [ ] If Option A's two-frame heuristic doesn't hold up under real-device
      testing, spike Option B (windowed single-grid virtualization) before
      committing further effort to Option A variants.
- [ ] `bunx tsc --noEmit`, `bunx biome ci .`, `bun run test` all clean.
- [ ] Confirm desktop (`!isTouch` path — `grid-focus-overlay`, hover-driven
      reveal) is untouched and still works; it was not part of this bug and
      shouldn't need any changes.

## Open questions

- Is a brief "tile is centred but hasn't started animating yet" delay (from
  Option A's settled-gate) actually acceptable, or does it need to feel
  instant even on a fast scroll-back? This trade was made unilaterally in
  this plan based on the session's evidence that the alternative (trying to
  make it instant) is what caused every prior regression — but worth
  confirming with the user before investing in Option A over Option B.
- Does the "two consecutive scan frames" heuristic need to be looser/tighter
  in practice? This should be tuned empirically against real Simulator
  video, not guessed.
- Should the vinyl disc's peek animation be simplified (e.g., dropped, or
  reduced to a smaller/less prominent movement) if it keeps being the
  source of this category of bug regardless of approach? Not this plan's
  call to make unilaterally, but worth raising if Option A still feels
  fragile after implementation.

## Chosen approach (2026-08-12)

A rebuild of the touch path around two ideas: **content windowing** (real
virtualization that can't produce grid gaps) and **one clock** (a single
rAF loop owns every per-frame value; no CSS transition, React state, or
browser-scheduled repaint participates in the scroll-driven animation).

### Content windowing, not node windowing

The dense-packed single grid can't unmount *grid children* (auto-placement
of every later tile depends on every earlier one), so every record keeps
its outer grid slot (same span, same `aspect-square` box) permanently
mounted — layout is bit-identical no matter where the window is, zero gap
risk, zero scroll-anchor jumps. What windows in and out is the slot's
*content*: tiles outside ±~1.5 viewport heights render a cheap static
placeholder circle instead of the `FadeImage` + `VinylDisc` subtree.
`content-visibility: auto` is removed from the touch path entirely (it
stays on desktop) — a windowed tile that's mounted is *always really
painted*, which deletes the unobservable paint-catchup clock that caused
every bug in this saga. A remounted tile has no stale paint state: its
cover either fades in fresh (first load) or mounts instantly opaque
(session decode cache) in the same frame as the DOM node itself.

Window membership is computed from a cached layout measurement (one batch
of `getBoundingClientRect`s per layout change — records, container resize —
then pure arithmetic against `scrollY` per frame; zero layout reads in the
scroll loop except one rect for the grid container) with hysteresis
(recompute every ~half viewport of travel), so React re-renders a few
times per screenful, not per frame, and memoized tiles keep each update to
the handful crossing the boundary.

### One-clock ambient effect

The proven pieces stay: trapezoid progress per tile, one-row-lit-at-a-time
column blend, eased chase. What changes:

- The same loop that eases progress now also drives the **disc's opacity**
  on touch (ramping in over the first stretch of progress). At rest the
  disc is simply invisible — which deletes the disc mask from the touch
  path (desktop keeps its own CSS mask), and with it the whole "hide the
  rest-state silhouette behind an alpha-transparent cover" problem.
- `syncCoverFade` (the replay mechanism) is deleted — real windowing makes
  remounting the fade.
- A tile is only eligible for nonzero progress once its cover is ready
  (`data-cover-ready`, written by React, read by the loop) — Option A's
  settled-gate, now trivially reliable because paint state equals mount
  state.
- A `data-touch` attribute on the grid lets CSS drop transitions on every
  property the loop drives per-frame (img `filter`/`scale`, disc
  `transform`/opacity), so CSS smoothing never fights JS easing — the JS
  chase is the only easing.
- `NowShowing`/`activeId` selection logic (band, anchor, row sweep) is
  kept as-is, just fed from the cached measurements.

## Implementation notes (2026-08-12, rebuild landed on `rebuild-touch-scroll`)

Built as described in "Chosen approach". Verified in the iOS Simulator per
the verification method (recorded real CGEvent-driven flings, frame-by-frame
inspection, plus a live WebDriver session for state assertions: 284 tiles,
~9-40 cover imgs mounted at a time, `data-touch` set).

The one significant discovery beyond the plan: after the rebuild, real-fling
frame timing (measured with the new `?perf` meter, a dev-only badge in
`collection-grid.tsx`) still showed 44-97ms main-thread frames. Isolation
(loop off → clean; active-tracking on / ambient writes off → clean;
windowing off → no change) pinned it entirely on the per-frame
`filter`/`scale`/`transform` style writes re-rasterizing non-composited
elements. Fix: `will-change: filter, scale` on covers and
`transform`/`opacity` on discs, scoped to `[data-touch]` (styles.css) so
layer memory is bounded by the content window, not the whole collection.
After promotion: worst frames 17-53ms with mostly 0 frames over a 34ms
budget — at parity with the no-JS-at-all baseline in the same measurement.
Notably `content-visibility` was *not* the only pseudo-virtualization cost —
and windowing commits (React mount/unmount of tile content) measured as
irrelevant to frame pacing, vindicating content windowing.

Remaining known trade: a hard fling into never-visited territory outruns
image loading and shows the static placeholder circles until covers arrive
(honest loading affordance; dev-server R2 latency exaggerates it vs
production CDN). Revisited territory remounts instantly from the session
decode cache.
