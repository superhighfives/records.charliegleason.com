-- Backfill `size`, `disc_count` (and `format` when still the default) from the
-- collector's own `capture_context` hint (e.g. "2×LP, 12\"") for records where
-- no Discogs pressing has been pinned yet — mirrors the fallback added to the
-- analysis pipeline in src/lib/analyze.ts, for records captured before that
-- change shipped.
--
-- Only touches rows that still look untouched: size is empty AND disc_count is
-- the schema default of 1 — a pinned pressing's real data is never overwritten.
--
--   Local:  wrangler d1 execute records --local  --file=scripts/backfill-size-disc-count-from-context.sql
--   Remote: wrangler d1 execute records --remote --file=scripts/backfill-size-disc-count-from-context.sql

UPDATE records
SET
  size = CASE
    WHEN capture_context LIKE '%12"%' THEN '12"'
    WHEN capture_context LIKE '%10"%' THEN '10"'
    WHEN capture_context LIKE '%7"%' THEN '7"'
    ELSE size
  END,
  disc_count = CASE
    WHEN capture_context LIKE '%6x%LP%' OR capture_context LIKE '%6×%LP%' THEN 6
    WHEN capture_context LIKE '%5x%LP%' OR capture_context LIKE '%5×%LP%' THEN 5
    WHEN capture_context LIKE '%4x%LP%' OR capture_context LIKE '%4×%LP%' THEN 4
    WHEN capture_context LIKE '%3x%LP%' OR capture_context LIKE '%3×%LP%' THEN 3
    WHEN capture_context LIKE '%2x%LP%' OR capture_context LIKE '%2×%LP%' THEN 2
    ELSE disc_count
  END,
  format = CASE
    WHEN format = 'LP' AND capture_context LIKE '%EP%' THEN 'EP'
    WHEN format = 'LP' AND capture_context LIKE '%single%' AND capture_context NOT LIKE '%single%lp%' THEN 'Single'
    ELSE format
  END,
  updated_at = (unixepoch())
WHERE capture_context IS NOT NULL
  AND capture_context != ''
  AND (size IS NULL OR size = '')
  AND (disc_count IS NULL OR disc_count = 1);
