---
title: Sharper captures without more Worker memory
status: In Progress
created: 2026-11-20
updated: 2026-11-20
---

# Sharper captures without more Worker memory

## Goal

Give the cover warp more detail from each capture, without raising the Worker's peak
memory. Covers are 2000px, but the sleeve inside a 2048px capture is often only about
1400px, so the warp upscales it.

## Context

- Three limits keep captures at 2048px: the browser downscale (`image-resize.ts`
  `TARGET_SIZE`), the server's canonical webp (`images.ts` `storeCapturePhotoFromR2`)
  and the decode cap (`professional.ts` `CAPTURE_DECODE_MAX`).
- The decode is the memory risk. `decodeRgba` holds the image twice (Photon's WASM
  buffer and the JS copy), and WASM memory never shrinks. A 3000px capture is about
  36 MB per copy, against a 128 MB isolate that has run out of memory before
  (`capture-first-pass.ts`).
- The Images binding can crop before it scales (`transform({ trim: { left, top, width,
  height } })`, in `worker-configuration.d.ts`), and it does the work off the JS heap.

## Approach

1. Store captures at up to 3072px: raise the browser downscale and the server's
   canonical size.
2. Decode only the sleeve. `loadCaptureRegion` reads the capture's size with
   `IMAGES.info`, crops to the inner quad's bounding box plus a 2% margin, scales that
   to at most 2048px, and decodes the result. The inner quad is remapped into the crop's
   coordinates for the warp. The stored band stays in full-image coordinates.
3. Peak memory stays at today's 2048² decode, whatever the capture size. The sleeve now
   fills most of that 2048px, so the cover gets about 2000px of real detail instead of
   about 1400.
4. Analysis sends Claude the capture scaled to 2048px, not the raw bytes, so a bigger
   capture can't exceed the image size limit.
5. Existing 2048px captures keep working; they take the same path.

## Tasks

- [x] Raise `TARGET_SIZE` and the canonical capture size to 3072.
- [x] Add `loadCaptureRegion`, and use it for Apply and the capture first pass.
- [x] Scale the capture for analysis.
- [ ] On the PR preview: capture a few new records on the phone, Apply each one, and
      compare against an old capture. Check Activity for failed Applies (an out-of-memory
      kill shows as "worker terminated" and a retry).
- [x] Confirm that `trim` crops before it scales. The binding's docs say it "is performed
      before resizing or rotation" (`worker-configuration.d.ts`, `trim`). The code passes
      only the four side cuts (`trimFor`), since the docs don't say how `width`/`height`
      combine with `left`/`top`. Still check the covers look right on the preview.

## Open questions

- Local dev's Images binding may not support `trim`. If it doesn't, Apply works only on
  the preview and production.
