ALTER TABLE users ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0 CHECK (is_admin IN (0, 1));
ALTER TABLE users ADD COLUMN is_owner INTEGER NOT NULL DEFAULT 0 CHECK (is_owner IN (0, 1));
ALTER TABLE users ADD COLUMN invited_by_code TEXT;
CREATE UNIQUE INDEX users_single_owner ON users(is_owner) WHERE is_owner = 1;

ALTER TABLE auth_challenges ADD COLUMN invite_code_hash TEXT;
ALTER TABLE auth_challenges ADD COLUMN device_link_code_hash TEXT;

CREATE TABLE gym_invites (
  code TEXT PRIMARY KEY NOT NULL,
  code_hash TEXT NOT NULL UNIQUE,
  note TEXT NOT NULL DEFAULT '',
  created_by_account_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  used_by_account_id TEXT REFERENCES users(id) ON DELETE SET NULL DEFERRABLE INITIALLY DEFERRED,
  used_at TEXT
);
CREATE INDEX gym_invites_used_by ON gym_invites(used_by_account_id);

CREATE TABLE gym_device_link_codes (
  account_id TEXT PRIMARY KEY NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT
);
CREATE UNIQUE INDEX gym_device_link_code_hash ON gym_device_link_codes(code_hash);

CREATE TABLE gym_admin_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL,
  event TEXT NOT NULL,
  ok INTEGER NOT NULL CHECK (ok IN (0, 1)),
  actor_account_id TEXT,
  actor_name TEXT NOT NULL,
  target_account_id TEXT,
  target_name TEXT,
  action TEXT,
  message TEXT,
  ip TEXT
);
CREATE INDEX gym_admin_audit_created ON gym_admin_audit(created_at DESC);

CREATE TABLE gym_media_cleanup_objects (
  object_key TEXT PRIMARY KEY NOT NULL,
  queued_at TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_error TEXT
);
CREATE INDEX gym_media_cleanup_pending ON gym_media_cleanup_objects(queued_at);
