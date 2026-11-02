ALTER TABLE gym_sync_state
  ADD COLUMN revision_source TEXT NOT NULL DEFAULT 'pwa'
  CHECK (revision_source IN ('pwa', 'mcp'));

CREATE TABLE gym_mcp_revisions (
  account_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL CHECK (revision > 0),
  revision_id TEXT NOT NULL UNIQUE,
  write_id TEXT,
  source TEXT NOT NULL CHECK (source IN ('pwa', 'mcp')),
  state_json TEXT NOT NULL CHECK (json_valid(state_json) AND length(state_json) <= 900000),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  restored_at TEXT,
  PRIMARY KEY (account_id, revision)
);

CREATE INDEX gym_mcp_revisions_account_expiry
  ON gym_mcp_revisions(account_id, expires_at, revision DESC);
