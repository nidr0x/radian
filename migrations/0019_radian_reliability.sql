ALTER TABLE gym_sync_changes ADD COLUMN write_id TEXT;

ALTER TABLE gym_media_cleanup_objects ADD COLUMN not_before TEXT NOT NULL DEFAULT '1970-01-01T00:00:00.000Z';
ALTER TABLE gym_media_cleanup_objects ADD COLUMN deleting_at TEXT;

CREATE INDEX gym_sync_changes_retention ON gym_sync_changes(created_at);
CREATE INDEX gym_sync_tombstones_retention ON gym_sync_tombstones(deleted_at);
CREATE INDEX gym_mcp_operations_retention ON gym_mcp_operations(created_at);
CREATE INDEX gym_mcp_pending_retention ON gym_mcp_pending_changes(expires_at, used_at);
CREATE INDEX gym_mcp_audit_retention ON gym_mcp_audit(created_at);
CREATE INDEX gym_admin_audit_retention ON gym_admin_audit(created_at);
CREATE INDEX gym_durable_jobs_retention ON gym_durable_jobs(status, updated_at);
CREATE INDEX gym_device_link_codes_retention ON gym_device_link_codes(expires_at, used_at);
CREATE INDEX gym_media_cleanup_due ON gym_media_cleanup_objects(not_before, deleting_at);
CREATE INDEX gym_media_references_account_media ON gym_media_references(account_id, media_id);
CREATE INDEX gym_media_objects_account_media ON gym_media_objects(account_id, media_id, object_key);
CREATE INDEX user_data_revisions_retention ON user_data_revisions(expires_at);
CREATE INDEX legacy_mcp_pending_retention ON mcp_pending_changes(expires_at, used_at);
CREATE INDEX mcp_write_receipts_retention ON mcp_write_receipts(created_at);
CREATE INDEX auth_sessions_retention ON auth_sessions(expires_at, revoked_at);
