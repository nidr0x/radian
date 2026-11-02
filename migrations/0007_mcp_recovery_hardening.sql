-- Precondition: Wrangler applies numbered migrations once and 0006 has already succeeded.
ALTER TABLE mcp_pending_changes ADD COLUMN claim_id TEXT;
ALTER TABLE mcp_pending_changes ADD COLUMN claimed_at TEXT;

CREATE TABLE mcp_revision_context (
  user_id TEXT PRIMARY KEY NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  revision_id TEXT NOT NULL,
  created_at TEXT NOT NULL
);

DROP TRIGGER IF EXISTS user_data_revision_after_update;
DROP TRIGGER IF EXISTS user_data_revision_after_delete;

CREATE TRIGGER user_data_revision_after_update
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

CREATE TRIGGER user_data_revision_after_delete
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
