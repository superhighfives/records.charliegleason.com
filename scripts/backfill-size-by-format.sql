-- Backfill missing `size` by format: LP -> 12", EP -> 10", Single -> 7".
--
-- Only touches rows where size is NULL/empty — records with an explicit size
-- (however set) are left alone.
--
--   Local:  wrangler d1 execute records --local  --file=scripts/backfill-size-by-format.sql
--   Remote: wrangler d1 execute records --remote --file=scripts/backfill-size-by-format.sql

UPDATE records
SET
  size = CASE format
    WHEN 'LP' THEN '12"'
    WHEN 'EP' THEN '10"'
    WHEN 'Single' THEN '7"'
  END,
  updated_at = (unixepoch())
WHERE (size IS NULL OR size = '')
  AND format IN ('LP', 'EP', 'Single');
