/**
 * Real-ESRGAN super-resolution constants — the "Enhance" step's shared tuning. Imported by
 * BOTH the Worker (`src/lib/professional.ts`) and the matte container
 * (`containers/matte/src/image-io.ts`) so the two ESRGAN paths can't drift: they did once
 * (an input-cap change landed on the Worker but not the container, changing the OOM behaviour
 * on only one path), which is why this lives in one pure module rather than duplicated
 * constants. Keep it dependency-free (no `cloudflare:workers`) so the container can bundle it.
 */

// Faithful (no diffusion, so it sharpens + denoises without inventing cover art / text),
// cheap, and quick. Pinned to a known version so the input schema can't shift under us.
export const REAL_ESRGAN_VERSION =
	"b3ef194191d13140337468c916c2c5b96dd0cb06dffc032a022a31807f6a5ea8";

// This runs on Replicate's SHARED T4 (~14.5 GiB), and the underlying network is a fixed
// x4 architecture: peak VRAM is the x4 forward pass over the *input*, so input pixels —
// not the `scale` param, which only resizes afterwards — govern OOM. 1400² x4 = 5600²
// (31M px) tips the T4 over (see the CUDA-OOM Sentry issues), and we then throw most of
// it away by capping to UPSCALE_MAX anyway. 1024² (1.05M px) x4 = 4096² lands right at
// the cap, so the stored master is unchanged while GPU activation memory drops ~47%.
export const UPSCALE_INPUT_MAX = 1024;

// 4× matches the model's native scale (asking for less wouldn't save VRAM — the x4 tensor
// is allocated regardless — and would only soften the result). 1024 → 4096px master.
export const UPSCALE_FACTOR = 4;

// Bound the stored master so a big upscale can't balloon R2. Set to the exact x4 output
// (1024 × 4) so the model's native result passes through without a redundant resample.
export const UPSCALE_MAX = 4096;
