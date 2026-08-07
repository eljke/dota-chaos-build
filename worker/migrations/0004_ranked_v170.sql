ALTER TABLE submissions ADD COLUMN completion_items INTEGER NOT NULL DEFAULT 6;
ALTER TABLE submissions ADD COLUMN completion_total INTEGER NOT NULL DEFAULT 6;
ALTER TABLE submissions ADD COLUMN completion_multiplier REAL NOT NULL DEFAULT 1;

CREATE TABLE verification_jobs (
  id TEXT PRIMARY KEY,
  attempt_id TEXT NOT NULL REFERENCES attempts(id) ON DELETE CASCADE,
  attempt_updated_at INTEGER NOT NULL,
  steam_id TEXT NOT NULL REFERENCES users(steam_id) ON DELETE CASCADE,
  match_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'retry', 'verified', 'rejected', 'error', 'stale')),
  message TEXT NOT NULL DEFAULT '',
  result_json TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE INDEX verification_jobs_by_attempt ON verification_jobs(attempt_id, created_at DESC);
CREATE INDEX verification_jobs_by_expiry ON verification_jobs(expires_at);
CREATE UNIQUE INDEX verification_jobs_one_active_attempt
  ON verification_jobs(attempt_id)
  WHERE status IN ('queued', 'running');
