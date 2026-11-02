CREATE TABLE gym_account_security (
  account_id TEXT PRIMARY KEY NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  password_hash TEXT,
  password_set_at TEXT,
  email TEXT,
  CHECK ((password_hash IS NULL AND password_set_at IS NULL) OR (password_hash IS NOT NULL AND password_set_at IS NOT NULL))
);

CREATE TABLE gym_login_identifiers (
  identifier_key TEXT NOT NULL,
  account_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('name', 'email')),
  value TEXT NOT NULL,
  PRIMARY KEY (identifier_key, account_id, kind),
  UNIQUE (account_id, kind)
);
CREATE INDEX gym_login_identifiers_account ON gym_login_identifiers(account_id);
CREATE TRIGGER gym_login_identifiers_one_account
BEFORE INSERT ON gym_login_identifiers
WHEN EXISTS (SELECT 1 FROM gym_login_identifiers WHERE identifier_key = NEW.identifier_key AND account_id <> NEW.account_id)
BEGIN
  SELECT RAISE(ABORT, 'identifier_taken');
END;

CREATE TABLE gym_password_reset_codes (
  account_id TEXT PRIMARY KEY NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  used_at TEXT
);
