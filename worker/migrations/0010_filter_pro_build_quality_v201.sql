DELETE FROM pro_build_samples;

UPDATE pro_refresh_seen
SET sample_count = -1, processed_at = unixepoch() - 601
WHERE sample_count >= 0;

UPDATE attempts
SET status = 'expired', updated_at = unixepoch()
WHERE build_style = 'pro'
  AND status IN ('rolling', 'committed');
