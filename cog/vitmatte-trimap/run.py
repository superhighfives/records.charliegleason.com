"""ViTMatte trimap matting for Replicate.

Input:  an RGB `image` and a grayscale `trimap` (0 = definite background,
        128 = unknown, 255 = definite foreground).
Output: a grayscale PNG alpha matte, at the working resolution (`max_size`).

The trimap is the whole point: the model only decides the *unknown* band, so a
locked-foreground cover interior and locked-background surround keep it from
cutting into the depicted artwork or grabbing a neighbouring object. The caller
(`src/lib/matte.ts`) builds the trimap from the admin's picked sleeve corners.
"""

import tempfile

import torch
from cog import BaseRunner, Input, Path
from PIL import Image
from transformers import VitMatteForImageMatting, VitMatteImageProcessor

MODEL = "hustvl/vitmatte-small-composition-1k"


class Runner(BaseRunner):
    def setup(self):
        self.processor = VitMatteImageProcessor.from_pretrained(MODEL)
        self.model = VitMatteForImageMatting.from_pretrained(MODEL)
        self.device = "cuda" if torch.cuda.is_available() else "cpu"
        self.model.to(self.device).eval()

    def run(
        self,
        image: Path = Input(description="RGB image to matte"),
        trimap: Path = Input(
            description="Grayscale trimap: 0=background, 128=unknown, 255=foreground"
        ),
        max_size: int = Input(
            description="Longest side the model runs at (alpha returned at this size; the caller resamples). Lower = faster / less VRAM.",
            default=1280,
            ge=512,
            le=2048,
        ),
    ) -> Path:
        img = Image.open(image).convert("RGB")
        tri = Image.open(trimap).convert("L")
        if tri.size != img.size:
            tri = tri.resize(img.size, Image.NEAREST)

        # Scale down large captures so a 2k input doesn't blow up VRAM; alpha is
        # returned at this working size and the caller upsamples it.
        w, h = img.size
        longest = max(w, h)
        if longest > max_size:
            s = max_size / longest
            w, h = round(w * s), round(h * s)
            img = img.resize((w, h), Image.BILINEAR)
            tri = tri.resize((w, h), Image.NEAREST)

        inputs = self.processor(images=img, trimaps=tri, return_tensors="pt")
        inputs = {k: v.to(self.device) for k, v in inputs.items()}
        with torch.no_grad():
            # (1, 1, H_padded, W_padded) — the processor pads to a multiple of 32.
            alphas = self.model(**inputs).alphas
        alpha = alphas[0, 0, :h, :w].clamp(0, 1).mul(255).round().byte().cpu().numpy()

        out = Path(tempfile.mkdtemp()) / "alpha.png"
        Image.fromarray(alpha, mode="L").save(out)
        return out
