# vitmatte-trimap

A [Cog](https://github.com/replicate/cog) wrapper around
[ViTMatte](https://huggingface.co/hustvl/vitmatte-small-composition-1k) for
**trimap-guided** image matting, deployed as a private Replicate model.

The app (`src/lib/matte.ts`) sends a deskewed sleeve `image` plus a `trimap`
built from the admin's picked corners — cover interior locked foreground, wood
beyond the edge locked background, a thin band around the edge left unknown.
ViTMatte only resolves that band, so it can't cut into the depicted artwork or
keep a neighbouring record. It returns a grayscale alpha the app composites over
its own capture pixels.

## Inputs

| field      | type  | notes                                                        |
| ---------- | ----- | ------------------------------------------------------------ |
| `image`    | file  | RGB image                                                    |
| `trimap`   | file  | grayscale, `0`=background, `128`=unknown, `255`=foreground   |
| `max_size` | int   | longest side the model runs at (default 1280); alpha is returned at this size and the app resamples it |

Output: a grayscale PNG alpha matte.

## Deploy

Prerequisites: [`cog`](https://github.com/replicate/cog) installed, Docker
running, and `cog login` done. Create a model on Replicate first (e.g.
`your-username/vitmatte-trimap`, hardware: a GPU such as Nvidia T4/A40).

The weights (~100 MB) download at first boot on Replicate's GPU rather than
being baked into the image — deliberately, so the `linux/amd64` CUDA build
doesn't have to execute torch under emulation (which OOMs BuildKit on Apple
Silicon). Expect one slow cold start on Replicate, then it's cached.

**If the build still dies with `EOF` / `Unavailable`:** it's Docker Desktop
running out of room. Bump its resources (Settings → Resources) to ~8 GB memory
and plenty of disk — this CUDA image is several GB — then `docker system prune`
and retry.

```sh
cd cog/vitmatte-trimap
# Optional local smoke test (needs a GPU, or runs slowly on CPU):
#   cog run -i image=@image.png -i trimap=@trimap.png
cog push r8.im/your-username/vitmatte-trimap
```

`cog push` prints the pushed **version hash**. Paste it into
`MATTE_MODEL_VERSION` in `src/lib/matte.ts`. Until it's set, the app falls back
to the free deterministic matte, so nothing breaks in the meantime.

Ensure the `REPLICATE_API_KEY` secret is set for the Worker (already used by the
Enhance/Real-ESRGAN path), and that the account can run the private model.
