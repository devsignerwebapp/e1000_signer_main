-- Profile photo (storage key, e.g. "avatars/<uuid>.jpg") and password-change tracking.
ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_path TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS password_changed_at TIMESTAMPTZ;
