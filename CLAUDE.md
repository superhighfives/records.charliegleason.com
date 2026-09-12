# records

Baseline rules live in [superhighfives/control-room](https://github.com/superhighfives/control-room/blob/main/BASELINE.md).
This file is the repo-specific part.

## Commands

Bun, not npm or pnpm. There is **no `typecheck` script** — CI runs
`bunx tsc --noEmit` directly, so use that. `bun run lint` is Biome.

## Layout

The web app lives in `apps/web/` (`src/`, `public/`, `wrangler.jsonc`,
`vite.config.ts`, and friends). Run `bun` scripts from the repo root — each one
`cd`s into `apps/web` itself. `rec/` (ESP32 firmware) and `mac/` (macOS
companion app) are separate, self-contained sibling projects.

## Imports

`#/*` maps to `./apps/web/src/*` (declared in `package.json` `imports`).
Prefer it over long relative chains.

## Generated — never hand-edit

- `apps/web/src/routeTree.gen.ts` — `bun run generate-routes`
- `apps/web/drizzle/` migrations — `bun run db:generate`

## Components

App UI lives in `apps/web/src/components/ui/` (shadcn-style) and
`apps/web/src/components/*.tsx`.
