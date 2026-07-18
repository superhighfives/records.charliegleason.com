-- One-time reset for the master-first record model.
--
-- Unlinks every specific release, clears the now-orphaned release-specific caches,
-- and unpublishes everything so each record flows back through the new
-- "pick an album (master) to publish" curation. Album-level data is kept:
-- artist, title, year, genre, cover, pitchfork score, notes, and masterId (which
-- is already NULL on pre-migration rows — you choose it per record). candidatesJson
-- is kept too, so the old release pick-list is still handy for optionally re-pinning
-- a pressing later.
--
-- Run order matters: apply migrations 0013 + 0014 FIRST (they add master_id/master_url
-- and drop confirmed_release), then run this.
--
--   Local:  wrangler d1 execute records --local  --file=scripts/reset-discogs-identity.sql
--   Remote: wrangler d1 execute records --remote --file=scripts/reset-discogs-identity.sql
--
-- Remote is destructive and empties the public homepage until records are re-curated —
-- run it deliberately.

UPDATE records
SET
  discogs_id = NULL,
  discogs_url = NULL,
  catno = NULL,
  country = NULL,
  size = NULL,
  discogs_value = NULL,
  discogs_value_currency = NULL,
  discogs_value_json = NULL,
  discogs_value_fetched_at = NULL,
  status = 'review',
  error = NULL,
  updated_at = (unixepoch())
-- Leave any in-flight capture alone so the queue consumer isn't disrupted mid-analysis.
WHERE status NOT IN ('pending', 'processing');
