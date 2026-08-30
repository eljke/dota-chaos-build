ALTER TABLE attempts ADD COLUMN build_style TEXT NOT NULL DEFAULT 'chaos';
ALTER TABLE attempts ADD COLUMN position TEXT;
ALTER TABLE attempts ADD COLUMN starting_items_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE attempts ADD COLUMN source_match_id TEXT;
ALTER TABLE attempts ADD COLUMN source_player TEXT;
ALTER TABLE attempts ADD COLUMN sample_count INTEGER NOT NULL DEFAULT 0;

ALTER TABLE submissions ADD COLUMN build_style TEXT NOT NULL DEFAULT 'chaos';
CREATE INDEX submissions_style_leaderboard ON submissions(build_style, mode, score DESC, verified_at ASC);

CREATE TABLE pro_accounts (
  account_id INTEGER PRIMARY KEY,
  player_name TEXT,
  leaderboard_rank INTEGER,
  last_seen INTEGER NOT NULL,
  next_normal_at INTEGER NOT NULL DEFAULT 0,
  next_turbo_at INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE pro_build_samples (
  match_id TEXT NOT NULL,
  player_slot INTEGER NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('normal', 'turbo')),
  hero_id INTEGER NOT NULL,
  position TEXT NOT NULL,
  starting_item_ids TEXT NOT NULL,
  core_item_ids TEXT NOT NULL,
  player_name TEXT NOT NULL,
  leaderboard_rank INTEGER,
  observed_at INTEGER NOT NULL,
  PRIMARY KEY (match_id, player_slot)
);

CREATE INDEX pro_build_samples_pool ON pro_build_samples(mode, hero_id, position, observed_at DESC);

INSERT OR IGNORE INTO pro_accounts
  (account_id, player_name, leaderboard_rank, last_seen, next_normal_at, next_turbo_at)
VALUES (321580662, 'Yatoro', 1, 0, 0, 0);
