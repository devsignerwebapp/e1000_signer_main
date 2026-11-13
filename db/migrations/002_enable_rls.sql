-- Supabase exposes the `public` schema through its auto-generated REST API (PostgREST).
-- Enabling Row Level Security with NO policies blocks the `anon` / `authenticated` roles from
-- reading or writing these tables through that API. Our Node backend connects as the table
-- owner (`postgres`), which bypasses RLS, so the app is unaffected. Harmless on plain Postgres.
ALTER TABLE usertypes            ENABLE ROW LEVEL SECURITY;
ALTER TABLE permissions          ENABLE ROW LEVEL SECURITY;
ALTER TABLE usertype_permissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE users                ENABLE ROW LEVEL SECURITY;
ALTER TABLE email_otps           ENABLE ROW LEVEL SECURITY;
ALTER TABLE documents            ENABLE ROW LEVEL SECURITY;
ALTER TABLE templates            ENABLE ROW LEVEL SECURITY;
ALTER TABLE submissions          ENABLE ROW LEVEL SECURITY;
ALTER TABLE api_keys             ENABLE ROW LEVEL SECURITY;
ALTER TABLE events               ENABLE ROW LEVEL SECURITY;
ALTER TABLE schema_migrations    ENABLE ROW LEVEL SECURITY;
