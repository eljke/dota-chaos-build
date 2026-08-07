ALTER TABLE attempts ADD COLUMN verification_retry_at INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS match_cache (
  match_id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  match_json TEXT NOT NULL,
  parsed INTEGER NOT NULL DEFAULT 0,
  fetched_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_match_cache_expires_at ON match_cache(expires_at);

CREATE TABLE IF NOT EXISTS match_requests (
  match_id TEXT PRIMARY KEY,
  parse_requested_at INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS provider_state (
  provider TEXT PRIMARY KEY,
  blocked_until INTEGER NOT NULL DEFAULT 0,
  reason TEXT NOT NULL DEFAULT '',
  updated_at INTEGER NOT NULL
);
