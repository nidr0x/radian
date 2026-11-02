CREATE TRIGGER IF NOT EXISTS revoke_mcp_credentials_when_user_disabled
AFTER UPDATE OF disabled ON users
WHEN NEW.disabled = 1 AND OLD.disabled <> 1
BEGIN
  UPDATE mcp_tokens
     SET revoked_at = COALESCE(revoked_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
   WHERE user_id = NEW.id AND revoked_at IS NULL;
  UPDATE mcp_authorization_codes
     SET used_at = COALESCE(used_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
   WHERE user_id = NEW.id AND used_at IS NULL;
  DELETE FROM mcp_authorization_requests WHERE user_id = NEW.id;
END;
