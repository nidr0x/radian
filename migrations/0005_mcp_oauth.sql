CREATE TABLE IF NOT EXISTS mcp_clients (
  client_id TEXT PRIMARY KEY NOT NULL,
  client_name TEXT NOT NULL,
  redirect_uris TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS mcp_authorization_requests (
  id TEXT PRIMARY KEY NOT NULL,
  client_id TEXT NOT NULL REFERENCES mcp_clients(client_id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  redirect_uri TEXT NOT NULL,
  code_challenge TEXT NOT NULL,
  scope TEXT NOT NULL,
  state TEXT,
  csrf_token_hash TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS mcp_authorization_requests_expiry_idx
  ON mcp_authorization_requests(expires_at);

CREATE TABLE IF NOT EXISTS mcp_authorization_codes (
  code_hash TEXT PRIMARY KEY NOT NULL,
  client_id TEXT NOT NULL REFERENCES mcp_clients(client_id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  redirect_uri TEXT NOT NULL,
  code_challenge TEXT NOT NULL,
  scope TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT
);

CREATE INDEX IF NOT EXISTS mcp_authorization_codes_expiry_idx
  ON mcp_authorization_codes(expires_at);

CREATE TABLE IF NOT EXISTS mcp_tokens (
  token_hash TEXT PRIMARY KEY NOT NULL,
  token_type TEXT NOT NULL CHECK (token_type IN ('access', 'refresh')),
  client_id TEXT NOT NULL REFERENCES mcp_clients(client_id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  scope TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT
);

CREATE INDEX IF NOT EXISTS mcp_tokens_user_idx ON mcp_tokens(user_id);
CREATE INDEX IF NOT EXISTS mcp_tokens_expiry_idx ON mcp_tokens(expires_at);
