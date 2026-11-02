-- Shared Coach configuration and opt-in cohort state. Provider credentials are stored only as
-- AES-GCM ciphertext; the wrapping key is injected through the runtime environment.
CREATE TABLE IF NOT EXISTS gym_coach_config (
  singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
  config_json TEXT NOT NULL CHECK (json_valid(config_json)),
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS gym_coach_credentials (
  provider TEXT PRIMARY KEY,
  ciphertext TEXT NOT NULL,
  iv TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS gym_coach_cohort_shares (
  account_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  sharing INTEGER NOT NULL CHECK (sharing IN (0, 1)),
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS gym_coach_cohort_shares_enabled
  ON gym_coach_cohort_shares(sharing, account_id);
