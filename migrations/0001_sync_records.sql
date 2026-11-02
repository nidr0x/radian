CREATE TABLE IF NOT EXISTS sync_records (
  sync_key TEXT PRIMARY KEY NOT NULL,
  payload TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
