CREATE TABLE IF NOT EXISTS user_data_revisions (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  payload TEXT NOT NULL,
  source TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  restored_at TEXT
);

CREATE INDEX IF NOT EXISTS user_data_revisions_user_expiry_idx
  ON user_data_revisions(user_id, expires_at);

CREATE INDEX IF NOT EXISTS user_data_revisions_expiry_idx
  ON user_data_revisions(expires_at);

CREATE TABLE IF NOT EXISTS mcp_pending_changes (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  client_id TEXT NOT NULL REFERENCES mcp_clients(client_id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  payload TEXT NOT NULL,
  base_updated_at TEXT NOT NULL,
  summary TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  claim_id TEXT,
  claimed_at TEXT,
  used_at TEXT
);

CREATE INDEX IF NOT EXISTS mcp_pending_changes_user_expiry_idx
  ON mcp_pending_changes(user_id, expires_at);

CREATE INDEX IF NOT EXISTS mcp_pending_changes_expiry_idx
  ON mcp_pending_changes(expires_at);

CREATE TABLE IF NOT EXISTS mcp_revision_context (
  user_id TEXT PRIMARY KEY NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  revision_id TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TRIGGER IF NOT EXISTS user_data_revision_after_update
AFTER UPDATE OF payload, updated_at ON user_data
WHEN old.payload <> new.payload
BEGIN
  INSERT INTO user_data_revisions
    (id, user_id, payload, source, created_at, expires_at)
  VALUES
    (COALESCE(
       (SELECT revision_id FROM mcp_revision_context WHERE user_id = old.user_id),
       lower(hex(randomblob(16)))
     ),
     old.user_id,
     old.payload,
     'automatic',
     COALESCE(
       (SELECT created_at FROM mcp_revision_context WHERE user_id = old.user_id),
       datetime('now')
     ),
     COALESCE(
       (SELECT datetime(created_at, '+30 days') FROM mcp_revision_context WHERE user_id = old.user_id),
       datetime('now', '+30 days')
     ));
  DELETE FROM mcp_revision_context WHERE user_id = old.user_id;
END;

CREATE TRIGGER IF NOT EXISTS user_data_revision_after_delete
AFTER DELETE ON user_data
BEGIN
  INSERT INTO user_data_revisions
    (id, user_id, payload, source, created_at, expires_at)
  VALUES
    (COALESCE(
       (SELECT revision_id FROM mcp_revision_context WHERE user_id = old.user_id),
       lower(hex(randomblob(16)))
     ),
     old.user_id,
     old.payload,
     'automatic',
     COALESCE(
       (SELECT created_at FROM mcp_revision_context WHERE user_id = old.user_id),
       datetime('now')
     ),
     COALESCE(
       (SELECT datetime(created_at, '+30 days') FROM mcp_revision_context WHERE user_id = old.user_id),
       datetime('now', '+30 days')
     ));
  DELETE FROM mcp_revision_context WHERE user_id = old.user_id;
END;
