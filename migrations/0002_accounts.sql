CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY NOT NULL,
  display_name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  session_version INTEGER NOT NULL DEFAULT 0,
  disabled INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS passkeys (
  credential_id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  public_key TEXT NOT NULL,
  counter INTEGER NOT NULL DEFAULT 0,
  transports TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  last_used_at TEXT
);

CREATE INDEX IF NOT EXISTS passkeys_user_id_idx ON passkeys(user_id);

CREATE TABLE IF NOT EXISTS auth_challenges (
  id TEXT PRIMARY KEY NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('register', 'login')),
  mode TEXT NOT NULL DEFAULT 'new_account' CHECK (mode IN ('new_account', 'add_passkey')),
  challenge TEXT NOT NULL,
  user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  display_name TEXT,
  expires_at TEXT NOT NULL,
  used_at TEXT
);

CREATE INDEX IF NOT EXISTS auth_challenges_expiry_idx ON auth_challenges(expires_at);

CREATE TABLE IF NOT EXISTS user_data (
  user_id TEXT PRIMARY KEY NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  payload TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
