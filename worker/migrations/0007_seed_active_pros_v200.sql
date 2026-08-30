INSERT INTO pro_accounts (account_id, player_name, leaderboard_rank, last_seen, next_normal_at, next_turbo_at) VALUES
  (1044002267, 'Satanic', 3, unixepoch(), 0, 0),
  (195108598, 'Noticed', 19, unixepoch(), 0, 0),
  (106573901, 'Noone', 80, unixepoch(), 0, 0),
  (164199202, '9Class', 28, unixepoch(), 0, 0),
  (73401082, 'Dukalis', 117, unixepoch(), 0, 0),
  (847565596, 'rue', 2, unixepoch(), 0, 0),
  (321580662, 'Yatoro', 1, unixepoch(), 0, 0),
  (106305042, 'Larl', 11, unixepoch(), 0, 0),
  (218231587, 'not me', 49, unixepoch(), 0, 0),
  (302214028, 'Collapse', 8, unixepoch(), 0, 0)
ON CONFLICT(account_id) DO UPDATE SET
  player_name = excluded.player_name,
  leaderboard_rank = excluded.leaderboard_rank,
  last_seen = excluded.last_seen,
  next_normal_at = 0,
  next_turbo_at = 0;
