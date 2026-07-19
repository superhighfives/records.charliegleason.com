# records

Baseline rules live in [superhighfives/control-room](https://github.com/superhighfives/control-room/blob/main/BASELINE.md).
This file is the repo-specific part.

## Commands

Bun, not npm or pnpm. There is **no `typecheck` script** — CI runs
`bunx tsc --noEmit` directly, so use that. `bun run lint` is Biome.

## Imports

`#/*` maps to `./src/*` (declared in `package.json` `imports`). Prefer it over
long relative chains.

## Generated — never hand-edit

- `src/routeTree.gen.ts` — `bun run generate-routes`
- `drizzle/` migrations — `bun run db:generate`

## Components

App UI lives in `src/components/ui/` (shadcn-style) and `src/components/*.tsx`.
