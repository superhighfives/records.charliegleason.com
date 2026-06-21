import { drizzle } from "drizzle-orm/d1";

import * as schema from "./schema.ts";

export { schema };

/**
 * Build a Drizzle client over a Cloudflare D1 binding.
 *
 * In a Worker the `DB` binding comes off the request `env`. With TanStack Start
 * on Cloudflare, grab it from the Cloudflare context inside a server function /
 * route handler and pass it here, e.g.:
 *
 *   import { env } from 'cloudflare:workers'
 *   const db = getDb(env.DB)
 */
export function getDb(d1: D1Database) {
	return drizzle(d1, { schema });
}

export type DB = ReturnType<typeof getDb>;
