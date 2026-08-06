PRAGMA foreign_keys = ON;

CREATE TABLE users (
  steam_id TEXT PRIMARY KEY,
  account_id INTEGER NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE oauth_states (
  state_hash TEXT PRIMARY KEY,
  return_to TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE login_codes (
  code_hash TEXT PRIMARY KEY,
  steam_id TEXT NOT NULL REFERENCES users(steam_id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);

CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  steam_id TEXT NOT NULL REFERENCES users(steam_id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE attempts (
  id TEXT PRIMARY KEY,
  steam_id TEXT NOT NULL REFERENCES users(steam_id) ON DELETE CASCADE,
  mode TEXT NOT NULL CHECK (mode IN ('normal', 'turbo')),
  order_required INTEGER NOT NULL CHECK (order_required IN (0, 1)),
  status TEXT NOT NULL CHECK (status IN ('rolling', 'committed', 'verified', 'expired')),
  roll_count INTEGER NOT NULL DEFAULT 0,
  seed TEXT NOT NULL,
  hero_id INTEGER NOT NULL,
  hero_key TEXT NOT NULL,
  hero_name TEXT NOT NULL,
  items_json TEXT NOT NULL,
  modifier_id TEXT,
  rules_version TEXT NOT NULL,
  data_version TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  committed_at INTEGER
);

CREATE INDEX attempts_active_by_user ON attempts(steam_id, status, created_at DESC);

CREATE TABLE submissions (
  id TEXT PRIMARY KEY,
  attempt_id TEXT NOT NULL UNIQUE REFERENCES attempts(id) ON DELETE CASCADE,
  steam_id TEXT NOT NULL REFERENCES users(steam_id) ON DELETE CASCADE,
  match_id TEXT NOT NULL,
  score INTEGER NOT NULL,
  rerolls INTEGER NOT NULL,
  order_required INTEGER NOT NULL,
  mode TEXT NOT NULL,
  modifier_id TEXT,
  evidence_json TEXT NOT NULL,
  verified_at INTEGER NOT NULL,
  UNIQUE(steam_id, match_id)
);

CREATE INDEX submissions_leaderboard ON submissions(mode, score DESC, verified_at ASC);
CREATE INDEX submissions_by_user ON submissions(steam_id, mode, score DESC);
