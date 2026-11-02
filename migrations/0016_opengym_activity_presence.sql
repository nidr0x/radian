-- Current workout snapshots only. The handlers expire these rows after 70 seconds, or
-- 45 seconds after a page is hidden; account deletion cascades the row immediately.
CREATE TABLE gym_activity_presence (
  account_id TEXT PRIMARY KEY NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL DEFAULT '',
  ex_idx INTEGER NOT NULL DEFAULT 0 CHECK (ex_idx BETWEEN 0 AND 200),
  ex_total INTEGER NOT NULL DEFAULT 0 CHECK (ex_total BETWEEN 0 AND 200),
  sets_done INTEGER NOT NULL DEFAULT 0 CHECK (sets_done BETWEEN 0 AND 10000),
  sets_total INTEGER NOT NULL DEFAULT 0 CHECK (sets_total BETWEEN 0 AND 10000),
  started_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  hidden_at INTEGER
);
CREATE INDEX gym_activity_presence_updated ON gym_activity_presence(updated_at);
CREATE INDEX gym_activity_presence_hidden ON gym_activity_presence(hidden_at) WHERE hidden_at IS NOT NULL;
