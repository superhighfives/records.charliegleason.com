---
title: Show clear and plastic sleeves as see-through
status: Backlog
created: 2026-10-25
updated: 2026-10-25
---

# Show clear and plastic sleeves as see-through

## Goal

Some records live in a clear outer sleeve: a poly bag over a white inner sleeve, a test
pressing in a plastic die-cut, a transparent PVC jacket. These should *read* as
transparent on the site, with the disc and inner sleeve visible through the plastic,
instead of a flat photo of a bag.

## Context

- The alpha matte ([[simplify-record-crop]]) promised "the sleeve as an object" but never
  handled this. ViTMatte cuts silhouettes; it can't model partial transmission, so plastic
  came out either opaque or holed.
- With the matte gone, every record is an opaque square cover with a CSS edge. That's
  the baseline this builds on.
- Motivating example: the CERES *Drag It Down On You* test pressing (CVLP058). It's a
  white inner sleeve with a label sticker, in a crinkled clear bag with taped edges, and
  the disc pokes out of the right side.
- What "transparent" means here is mostly *the vinyl showing through*. The grid already
  has a `VinylDisc` behind every cover that peeks on hover. A clear sleeve could let it
  show through at rest, which is something an opaque cover never could.

## Ideas (none settled)

1. **A per-record flag plus CSS. Cheapest, and needs no new image processing.**
   - Add a `sleeveKind` value (`standard | clear | die-cut`), set in the admin.
   - For `clear`, render the cover at partial opacity over the disc, or with
     `mix-blend-mode: multiply` / `screen`. Add a faint frosted-plastic layer
     (`backdrop-filter`, a subtle sheen gradient) and let the disc peek through at rest.
   - It won't be physically right (the photo already contains the disc and the inner
     sleeve), but it may read well enough.
2. **A two-shot capture: real transmission.** Photograph the record on a white board, then
   on a black one, from the same position. Per pixel, the difference gives opacity and the
   black shot gives colour. It's the classic difference matte, and fully deterministic. It
   costs an extra capture step only for clear records and needs a stable second shot
   (align with the existing corner warp).
3. **A hand-painted mask per record.** Upload or draw a mask in the admin for the few
   records that need it. That's high fidelity and fully manual, and fine if there are
   only a handful.
4. **A die-cut shape library.** For die-cut sleeves (a centre hole, a window), use a small
   set of SVG masks combined with the existing `clip-path` edge. That's a different
   problem from plastic, but it's cheap to cover at the same time.

## Open questions

- How many records are clear or plastic? If it's under ~10, option 3 (or 1) is enough.
- Should the disc show through at rest (a new resting look), or only on hover like
  everything else?
- Is the crinkled bag part of the charm (keep the photo, just let the disc read through),
  or should it look like clean clear plastic?
- Is the inner sleeve the "cover" for these records, or the bag?
