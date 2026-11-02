ALTER TABLE sync_records ADD COLUMN payload_bytes INTEGER NOT NULL DEFAULT 0;
UPDATE sync_records SET payload_bytes = length(CAST(payload AS BLOB));

CREATE TABLE sync_storage_quota (
  singleton INTEGER PRIMARY KEY NOT NULL CHECK (singleton = 1),
  record_count INTEGER NOT NULL CHECK (record_count >= 0),
  payload_bytes INTEGER NOT NULL CHECK (payload_bytes >= 0)
);

CREATE TABLE sync_storage_daily_quota (
  quota_day TEXT PRIMARY KEY NOT NULL,
  record_count INTEGER NOT NULL CHECK (record_count >= 0),
  payload_bytes INTEGER NOT NULL CHECK (payload_bytes >= 0)
);

INSERT INTO sync_storage_quota (singleton, record_count, payload_bytes)
SELECT 1, COUNT(*), COALESCE(SUM(payload_bytes), 0) FROM sync_records;

CREATE TRIGGER sync_records_quota_before_insert
BEFORE INSERT ON sync_records
WHEN NOT EXISTS (SELECT 1 FROM sync_records WHERE sync_key = NEW.sync_key)
 AND (
   (SELECT record_count FROM sync_storage_quota WHERE singleton = 1) >= 10000
   OR (SELECT payload_bytes FROM sync_storage_quota WHERE singleton = 1) + NEW.payload_bytes > 134217728
 )
BEGIN
  SELECT RAISE(ABORT, 'sync_storage_quota_exceeded');
END;

CREATE TRIGGER sync_records_creation_quota_before_insert
BEFORE INSERT ON sync_records
WHEN NOT EXISTS (SELECT 1 FROM sync_records WHERE sync_key = NEW.sync_key)
 AND (
   COALESCE((SELECT record_count FROM sync_storage_daily_quota WHERE quota_day = substr(NEW.updated_at, 1, 10)), 0) >= 500
   OR COALESCE((SELECT payload_bytes FROM sync_storage_daily_quota WHERE quota_day = substr(NEW.updated_at, 1, 10)), 0) + NEW.payload_bytes > 33554432
 )
BEGIN
  SELECT RAISE(ABORT, 'sync_creation_quota_exceeded');
END;

CREATE TRIGGER sync_records_quota_before_update
BEFORE UPDATE OF payload_bytes ON sync_records
WHEN NEW.payload_bytes > OLD.payload_bytes
 AND (SELECT payload_bytes FROM sync_storage_quota WHERE singleton = 1) + NEW.payload_bytes - OLD.payload_bytes > 134217728
BEGIN
  SELECT RAISE(ABORT, 'sync_storage_quota_exceeded');
END;

CREATE TRIGGER sync_records_quota_after_insert
AFTER INSERT ON sync_records
BEGIN
  UPDATE sync_storage_quota SET record_count = record_count + 1, payload_bytes = payload_bytes + NEW.payload_bytes WHERE singleton = 1;
END;

CREATE TRIGGER sync_records_creation_quota_after_insert
AFTER INSERT ON sync_records
BEGIN
  INSERT INTO sync_storage_daily_quota (quota_day, record_count, payload_bytes)
  VALUES (substr(NEW.updated_at, 1, 10), 1, NEW.payload_bytes)
  ON CONFLICT(quota_day) DO UPDATE SET
    record_count = record_count + 1,
    payload_bytes = payload_bytes + NEW.payload_bytes;
END;

CREATE TRIGGER sync_records_quota_after_delete
AFTER DELETE ON sync_records
BEGIN
  UPDATE sync_storage_quota SET record_count = record_count - 1, payload_bytes = payload_bytes - OLD.payload_bytes WHERE singleton = 1;
END;

CREATE TRIGGER sync_records_quota_after_update
AFTER UPDATE OF payload_bytes ON sync_records
WHEN NEW.payload_bytes <> OLD.payload_bytes
BEGIN
  UPDATE sync_storage_quota SET payload_bytes = payload_bytes + NEW.payload_bytes - OLD.payload_bytes WHERE singleton = 1;
END;
