-- Preferred language for emails (OTP, invitations, notifications). 'en' (default) | 'az'
ALTER TABLE users ADD COLUMN IF NOT EXISTS locale VARCHAR(5) NOT NULL DEFAULT 'en';
