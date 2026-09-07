CREATE TABLE mcp_write_receipts (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  client_id TEXT NOT NULL REFERENCES mcp_clients(client_id) ON DELETE CASCADE,
  request_key TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  tool TEXT NOT NULL,
  result TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (user_id, client_id, request_key)
);
CREATE INDEX mcp_write_receipts_user_date ON mcp_write_receipts(user_id, created_at);
