import { config } from 'dotenv'
import { defineConfig } from 'drizzle-kit'

config({ path: ['.env.local', '.env'] })

// Cloudflare D1 (SQLite). `drizzle-kit generate` only needs the schema + dialect
// and emits migration SQL to ./drizzle — apply those with:
//   bunx wrangler d1 migrations apply records --local   (dev)
//   bunx wrangler d1 migrations apply records --remote  (prod)
// The d1-http driver below powers `db:push` / `db:studio` against the remote D1
// and needs CLOUDFLARE_ACCOUNT_ID / CLOUDFLARE_DATABASE_ID / CLOUDFLARE_D1_TOKEN.
export default defineConfig({
  out: './drizzle',
  schema: './src/db/schema.ts',
  dialect: 'sqlite',
  driver: 'd1-http',
  dbCredentials: {
    accountId: process.env.CLOUDFLARE_ACCOUNT_ID!,
    databaseId: process.env.CLOUDFLARE_DATABASE_ID!,
    token: process.env.CLOUDFLARE_D1_TOKEN!,
  },
})
