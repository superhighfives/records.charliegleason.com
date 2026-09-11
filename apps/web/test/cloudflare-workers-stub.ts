/**
 * Stand-in for the `cloudflare:workers` virtual module under vitest (Node).
 * Aliased in vitest.config.ts. `env` is empty by default — tests that depend on a
 * specific binding/secret should set it explicitly (e.g. `env.SERPAPI_KEY = "x"`).
 */
export const env: Record<string, unknown> = {};
