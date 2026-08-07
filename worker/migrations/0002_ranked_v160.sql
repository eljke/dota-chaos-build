ALTER TABLE users ADD COLUMN avatar_url TEXT NOT NULL DEFAULT '';
ALTER TABLE attempts ADD COLUMN cancel_penalties INTEGER NOT NULL DEFAULT 0;
ALTER TABLE submissions ADD COLUMN cancel_penalties INTEGER NOT NULL DEFAULT 0;

CREATE TABLE ranked_penalties (
  steam_id TEXT NOT NULL REFERENCES users(steam_id) ON DELETE CASCADE,
  mode TEXT NOT NULL CHECK (mode IN ('normal', 'turbo')),
  cancel_penalties INTEGER NOT NULL DEFAULT 0 CHECK (cancel_penalties >= 0),
  cooldown_until INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (steam_id, mode)
);
