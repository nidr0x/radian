-- Operation-gated, field-level synchronization. A D1 batch alone is not a CAS: an UPDATE
-- that affects zero rows does not prevent later statements from running. Every write below
-- therefore checks the gate row created only when the account revision and touched-field
-- revisions still match the request.
CREATE TABLE gym_sync_gates (
  account_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  operation_id TEXT NOT NULL,
  base_cursor INTEGER NOT NULL CHECK (base_cursor >= 0),
  fingerprint TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (account_id, operation_id)
);

CREATE TABLE gym_sync_receipts (
  account_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  operation_id TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision >= 0),
  write_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (account_id, operation_id)
);
CREATE INDEX gym_sync_receipts_expiry ON gym_sync_receipts(created_at);

CREATE TABLE gym_sync_field_revisions (
  account_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  field_path TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision > 0),
  PRIMARY KEY (account_id, field_path)
);

-- Append-only deltas let offline clients replay from a cursor. Each value is a bounded field or
-- row delta; binary payloads are references to R2, never embedded here.
CREATE TABLE gym_sync_changes (
  account_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL CHECK (revision > 0),
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  operation_id TEXT NOT NULL,
  field_path TEXT NOT NULL,
  value_json TEXT CHECK (value_json IS NULL OR (json_valid(value_json) AND length(value_json) <= 65536)),
  deleted INTEGER NOT NULL DEFAULT 0 CHECK (deleted IN (0, 1)),
  created_at TEXT NOT NULL,
  PRIMARY KEY (account_id, revision, ordinal),
  CHECK ((deleted = 1 AND value_json IS NULL) OR deleted = 0)
);
CREATE INDEX gym_sync_changes_cursor ON gym_sync_changes(account_id, revision, ordinal);
CREATE INDEX gym_sync_changes_operation ON gym_sync_changes(account_id, operation_id);

CREATE TABLE gym_sync_tombstones (
  account_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  deleted_at TEXT NOT NULL,
  delete_revision INTEGER NOT NULL CHECK (delete_revision > 0),
  PRIMARY KEY (account_id, entity_type, entity_id)
);
CREATE INDEX gym_sync_tombstones_account_revision ON gym_sync_tombstones(account_id, delete_revision);

-- User media is owned by an account, while pairing media below remains encrypted end-to-end
-- and independent of account identity. Object keys are random opaque IDs, not content hashes.
CREATE TABLE gym_media_objects (
  account_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  media_id TEXT NOT NULL,
  object_key TEXT NOT NULL UNIQUE,
  sha256 TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  byte_size INTEGER NOT NULL CHECK (byte_size >= 0),
  created_at TEXT NOT NULL,
  PRIMARY KEY (account_id, media_id)
);
CREATE INDEX gym_media_objects_account_date ON gym_media_objects(account_id, created_at);

CREATE TABLE gym_media_references (
  account_id TEXT NOT NULL,
  media_id TEXT NOT NULL,
  owner_type TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  PRIMARY KEY (account_id, media_id, owner_type, owner_id),
  FOREIGN KEY (account_id, media_id) REFERENCES gym_media_objects(account_id, media_id) ON DELETE CASCADE
);
CREATE INDEX gym_media_references_owner ON gym_media_references(account_id, owner_type, owner_id);

-- The server stores only a locator derived by the client and a SHA-256 verifier of the
-- authorization key. It never receives the master or AES encryption key. Small ciphertexts
-- may live inline; large encrypted snapshots and encrypted media are immutable R2 objects.
CREATE TABLE gym_pair_channels (
  pair_id TEXT PRIMARY KEY NOT NULL,
  authorization_verifier TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
  ciphertext TEXT CHECK (ciphertext IS NULL OR length(ciphertext) <= 65536),
  r2_object_key TEXT,
  ciphertext_sha256 TEXT,
  ciphertext_bytes INTEGER NOT NULL DEFAULT 0 CHECK (ciphertext_bytes >= 0),
  last_active_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  CHECK ((ciphertext IS NULL) OR (r2_object_key IS NULL)),
  CHECK (revision = 0 OR ciphertext_sha256 IS NOT NULL)
);
CREATE INDEX gym_pair_channels_expiry ON gym_pair_channels(expires_at);

-- Revocation tombstones prevent a key derived from an old master from recreating the same
-- channel after expiry or deletion. Retention is enforced by a later bounded cleanup job.
CREATE TABLE gym_pair_tombstones (
  pair_id TEXT PRIMARY KEY NOT NULL,
  revoked_at TEXT NOT NULL,
  retain_until TEXT NOT NULL
);
CREATE INDEX gym_pair_tombstones_expiry ON gym_pair_tombstones(retain_until);

CREATE TABLE gym_pair_media_objects (
  pair_id TEXT NOT NULL REFERENCES gym_pair_channels(pair_id) ON DELETE CASCADE,
  object_id TEXT NOT NULL,
  object_key TEXT NOT NULL UNIQUE,
  ciphertext_sha256 TEXT NOT NULL,
  ciphertext_bytes INTEGER NOT NULL CHECK (ciphertext_bytes >= 0),
  created_revision INTEGER NOT NULL CHECK (created_revision > 0),
  created_at TEXT NOT NULL,
  PRIMARY KEY (pair_id, object_id)
);
CREATE INDEX gym_pair_media_revision ON gym_pair_media_objects(pair_id, created_revision);

-- R2 deletion is external to a D1 transaction. Record obsolete immutable objects before the
-- code attempts to delete them; a later bounded maintenance run can retry any failed deletion.
CREATE TABLE gym_pair_cleanup_objects (
  object_key TEXT PRIMARY KEY NOT NULL,
  pair_id TEXT NOT NULL,
  queued_at TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_error TEXT
);
CREATE INDEX gym_pair_cleanup_pending ON gym_pair_cleanup_objects(queued_at);

CREATE TABLE gym_push_subscriptions (
  account_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  subscription_id TEXT NOT NULL,
  endpoint_hash TEXT NOT NULL UNIQUE,
  endpoint TEXT NOT NULL,
  public_key TEXT NOT NULL,
  auth_secret TEXT NOT NULL,
  device_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (account_id, subscription_id)
);
CREATE INDEX gym_push_subscriptions_device ON gym_push_subscriptions(account_id, device_id);

CREATE TABLE gym_durable_jobs (
  job_id TEXT PRIMARY KEY NOT NULL,
  account_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  owner_type TEXT NOT NULL CHECK (owner_type IN ('account', 'guest')),
  owner_key TEXT NOT NULL,
  job_type TEXT NOT NULL CHECK (job_type IN ('coach', 'push', 'rest_timer')),
  idempotency_key TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json) AND length(payload_json) <= 65536),
  attempt INTEGER NOT NULL DEFAULT 0 CHECK (attempt >= 0),
  run_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  result_json TEXT CHECK (result_json IS NULL OR (json_valid(result_json) AND length(result_json) <= 65536)),
  UNIQUE (job_type, owner_key, idempotency_key),
  UNIQUE (account_id, job_id),
  CHECK ((owner_type = 'account' AND account_id IS NOT NULL AND owner_key = account_id)
      OR (owner_type = 'guest' AND account_id IS NULL))
);
CREATE INDEX gym_durable_jobs_ready ON gym_durable_jobs(status, run_at);
CREATE INDEX gym_durable_jobs_owner ON gym_durable_jobs(owner_key, created_at);
CREATE UNIQUE INDEX gym_durable_jobs_one_active_coach ON gym_durable_jobs(account_id)
  WHERE job_type = 'coach' AND status IN ('queued', 'running');

CREATE TABLE gym_coach_proposals (
  account_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  proposal_id TEXT NOT NULL,
  job_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'accepted', 'rejected', 'dismissed', 'stale')),
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json) AND length(payload_json) <= 65536),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (account_id, proposal_id),
  FOREIGN KEY (account_id, job_id) REFERENCES gym_durable_jobs(account_id, job_id) ON DELETE CASCADE
);

-- MCP uses the same account revision and operation IDs as the web sync writer. These rows are
-- metadata only; the existing OAuth client/token/revision migrations 0005–0010 stay immutable.
CREATE TABLE gym_mcp_operations (
  account_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  operation_id TEXT NOT NULL,
  client_id TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision >= 0),
  result_json TEXT NOT NULL CHECK (json_valid(result_json) AND length(result_json) <= 16384),
  created_at TEXT NOT NULL,
  PRIMARY KEY (account_id, client_id, operation_id)
);
CREATE TABLE gym_mcp_pending_changes (
  account_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  client_id TEXT NOT NULL,
  change_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json) AND length(payload_json) <= 900000),
  preview_json TEXT NOT NULL CHECK (json_valid(preview_json) AND length(preview_json) <= 16384),
  base_revision INTEGER NOT NULL CHECK (base_revision >= 0),
  base_write_id TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  PRIMARY KEY (account_id, change_id)
);
CREATE INDEX gym_mcp_pending_changes_expiry ON gym_mcp_pending_changes(account_id, expires_at, used_at);

CREATE TABLE gym_mcp_audit (
  event_id TEXT PRIMARY KEY NOT NULL,
  account_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  client_id TEXT,
  tool_name TEXT NOT NULL,
  action TEXT NOT NULL,
  outcome TEXT NOT NULL,
  summary_json TEXT NOT NULL CHECK (json_valid(summary_json) AND length(summary_json) <= 16384),
  created_at TEXT NOT NULL
);
CREATE INDEX gym_mcp_audit_account_date ON gym_mcp_audit(account_id, created_at DESC);
