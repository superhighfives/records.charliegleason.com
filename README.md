# records.charliegleason.com

My vinyl collection, online. The public side is a filterable grid of sleeves with notes, Pitchfork scores and Discogs details. The admin side is how records get in: I photograph a sleeve on my phone, and the app crops it, works out what it is, and matches it to Discogs.

Status: active. Started in 2026.
Live: https://records.charliegleason.com

## Running it

Dev runs against the real Cloudflare D1 database and R2 bucket (there's no local database), so you need to be logged in to Wrangler first. `SETUP.md` has the full setup, including the Cloudflare resources, accounts and keys involved.

```bash
bun install
bunx wrangler login
cp .env.example .env.local
bun run dev          # http://localhost:3000
```

The minimum to boot is `VITE_CLERK_PUBLISHABLE_KEY` and `CLERK_SECRET_KEY`. `DISCOGS_TOKEN`, `REPLICATE_API_KEY`, `LASTFM_API_KEY`, `LASTFM_USER`, `SERPAPI_KEY`, `CRON_SECRET` and the `VITE_SENTRY_*` variables switch on their features, and the app degrades without them. `.env.example` explains each one.

Other scripts:

```bash
bun run test         # Vitest
bun run check        # Biome lint and format
bun run db:generate  # new Drizzle migration after editing apps/web/src/db/schema.ts
bun run db:migrate   # apply migrations to the remote D1 database
bun run build:wasm   # rebuild the Rust sleeve detectors in crates/
```

## Deploying

Production deploys run in GitHub Actions (`.github/workflows/deploy.yml`) on every push to `main`. Don't deploy from a laptop: Vite inlines `VITE_CLERK_PUBLISHABLE_KEY` at build time, so a local `bun run deploy` would ship the test Clerk key from `.env.local`. CI builds with the production key from repo secrets.

Runtime secrets are set once on the Worker with `bunx wrangler secret put <NAME>` and persist across deploys. Bindings (D1, R2, Workers AI, Images, queues, email) live in `apps/web/wrangler.jsonc`.

Each pull request gets its own preview Worker at `records-pr-<number>.<subdomain>.workers.dev`, posted as a PR comment and torn down when the PR closes. Previews share the production D1 database and R2 bucket, so edits made on a preview are real.

## How it works

- TanStack Start on Cloudflare Workers, with TanStack Router, Query, DB, Table and Form, Tailwind and shadcn/ui. The Worker entry is `apps/web/src/server.ts`, which adds cron and queue handlers around the TanStack Start fetch handler.
- Data lives in D1 through Drizzle, and photos live in R2. The read endpoints under `/api` are public. Everything under `/admin` sits behind Clerk.
- Capture: a photo is uploaded to R2 and processed on a queue. A learned corner detector (Rust compiled to WebAssembly, in `crates/`, trained by the pipeline in `ml/`) finds the sleeve, and the app perspective-corrects and crops it. Claude, through Workers AI and AI Gateway, reads the sleeve, then the app matches it against Discogs and The Fork for Pitchfork scores.
- Cron jobs send a daily "record of the day" email (replying to it saves the reply as that record's notes), a weekly "records to buy" digest built from my Last.fm listening, and a daily check that Discogs links still resolve.
- `rec/` is firmware for a Waveshare ESP32-S3 touch screen that shows the collection, and `mac/` is a small macOS app that plays an album in Apple Music when you tap it on the board.
- `fly/discogs-proxy` is an optional proxy on Fly.io that gives Discogs requests a dedicated IP, because Discogs rate-limits Cloudflare's shared ones.
