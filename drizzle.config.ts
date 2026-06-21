import { defineConfig } from 'drizzle-kit'

// Cloudflare D1 (SQLite). We only use `drizzle-kit generate` to emit migration SQL
// from the schema — no DB connection, no credentials. Migrations are applied to the
// remote D1 with Wrangler (there is no local DB; dev uses remoteBindings):
//   bun run db:generate
//   bunx wrangler d1 migrations apply records --remote
export default defineConfig({
  out: './drizzle',
  schema: './src/db/schema.ts',
  dialect: 'sqlite',
})
