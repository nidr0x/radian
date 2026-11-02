ALTER TABLE passkeys ADD COLUMN label TEXT NOT NULL DEFAULT 'Passkey';
ALTER TABLE auth_challenges ADD COLUMN passkey_label TEXT;
