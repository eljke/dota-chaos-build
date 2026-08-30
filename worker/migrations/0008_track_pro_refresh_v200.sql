CREATE TABLE IF NOT EXISTS pro_refresh_seen (
  match_id TEXT PRIMARY KEY,
  mode TEXT NOT NULL CHECK (mode IN ('normal', 'turbo')),
  processed_at INTEGER NOT NULL,
  sample_count INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_pro_refresh_seen_processed
  ON pro_refresh_seen(processed_at);
