-- E1000Signer initial schema
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ─────────────────────────────────────────────────────────────
-- Access control: usertypes ⟷ permissions (many-to-many) ⟵ users
-- ─────────────────────────────────────────────────────────────
CREATE TABLE usertypes (
  id           SERIAL PRIMARY KEY,
  code         VARCHAR(32)  NOT NULL UNIQUE,      -- guest | user | pro | admin
  name         VARCHAR(64)  NOT NULL,
  description  TEXT,
  is_paid      BOOLEAN      NOT NULL DEFAULT FALSE,
  sort_order   INT          NOT NULL DEFAULT 0,
  created_at   TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE TABLE permissions (
  id           SERIAL PRIMARY KEY,
  code         VARCHAR(64)  NOT NULL UNIQUE,      -- e.g. template.create
  category     VARCHAR(32)  NOT NULL,             -- document | template | api | admin | pro | demo
  description  TEXT,
  created_at   TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE TABLE usertype_permissions (
  usertype_id   INT NOT NULL REFERENCES usertypes(id)   ON DELETE CASCADE,
  permission_id INT NOT NULL REFERENCES permissions(id) ON DELETE CASCADE,
  PRIMARY KEY (usertype_id, permission_id)
);

CREATE TABLE users (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email          VARCHAR(255) NOT NULL,
  password_hash  VARCHAR(255) NOT NULL,
  full_name      VARCHAR(120) NOT NULL,
  company        VARCHAR(120),
  usertype_id    INT NOT NULL REFERENCES usertypes(id),
  is_verified    BOOLEAN NOT NULL DEFAULT FALSE,
  is_active      BOOLEAN NOT NULL DEFAULT TRUE,
  webhook_url    TEXT,
  webhook_secret VARCHAR(80),
  last_login_at  TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX users_email_lower_uq ON users (lower(email));
CREATE INDEX users_usertype_idx ON users (usertype_id);

-- 4-digit OTP codes (stored hashed)
CREATE TABLE email_otps (
  id           BIGSERIAL PRIMARY KEY,
  user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  purpose      VARCHAR(32) NOT NULL DEFAULT 'register',
  code_hash    VARCHAR(255) NOT NULL,
  attempts     INT NOT NULL DEFAULT 0,
  expires_at   TIMESTAMPTZ NOT NULL,
  consumed_at  TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX email_otps_user_idx ON email_otps (user_id, purpose, created_at DESC);

-- ─────────────────────────────────────────────────────────────
-- Documents, templates, submissions
-- ─────────────────────────────────────────────────────────────
CREATE TABLE documents (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title          VARCHAR(200) NOT NULL,
  original_name  VARCHAR(255) NOT NULL,
  file_path      TEXT NOT NULL,                -- relative to STORAGE_DIR
  signed_path    TEXT,                         -- latest signed version
  page_count     INT NOT NULL DEFAULT 0,
  size_bytes     BIGINT NOT NULL DEFAULT 0,
  status         VARCHAR(20) NOT NULL DEFAULT 'uploaded',   -- uploaded | signed
  source         VARCHAR(20) NOT NULL DEFAULT 'web',        -- web | api
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX documents_owner_idx ON documents (owner_id, created_at DESC);

CREATE TABLE templates (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  document_id      UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  name             VARCHAR(200) NOT NULL,
  message          TEXT,
  allowed_sign_types TEXT[] NOT NULL DEFAULT ARRAY['draw','type','upload'],
  fields           JSONB NOT NULL DEFAULT '[]'::jsonb,  -- [{id,page,x,y,w,h,label,required}] normalized 0..1
  share_token      VARCHAR(64) NOT NULL UNIQUE,
  is_active        BOOLEAN NOT NULL DEFAULT TRUE,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX templates_owner_idx ON templates (owner_id, created_at DESC);

CREATE TABLE submissions (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  template_id    UUID NOT NULL REFERENCES templates(id) ON DELETE CASCADE,
  signer_name    VARCHAR(120) NOT NULL,
  signer_email   VARCHAR(255),
  signed_path    TEXT NOT NULL,
  download_token VARCHAR(64) NOT NULL UNIQUE,
  sign_types_used TEXT[] NOT NULL DEFAULT '{}',
  ip_address     VARCHAR(64),
  user_agent     TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX submissions_template_idx ON submissions (template_id, created_at DESC);

-- ─────────────────────────────────────────────────────────────
-- Developer access
-- ─────────────────────────────────────────────────────────────
CREATE TABLE api_keys (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name          VARCHAR(80) NOT NULL,
  key_prefix    VARCHAR(16) NOT NULL,      -- shown in UI, e.g. "e1k_ab12cd"
  key_hash      VARCHAR(128) NOT NULL UNIQUE,  -- sha256 of full key
  last_used_at  TIMESTAMPTZ,
  revoked_at    TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX api_keys_user_idx ON api_keys (user_id);

-- ─────────────────────────────────────────────────────────────
-- Audit / activity events (admin dashboard + overview chart)
-- ─────────────────────────────────────────────────────────────
CREATE TABLE events (
  id          BIGSERIAL PRIMARY KEY,
  user_id     UUID REFERENCES users(id) ON DELETE SET NULL,
  type        VARCHAR(64) NOT NULL,       -- e.g. auth.register, document.signed
  category    VARCHAR(32) NOT NULL,       -- auth | document | template | submission | api | admin | demo
  entity_id   TEXT,
  meta        JSONB NOT NULL DEFAULT '{}'::jsonb,
  ip_address  VARCHAR(64),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX events_created_idx  ON events (created_at DESC);
CREATE INDEX events_category_idx ON events (category, created_at DESC);
CREATE INDEX events_user_idx     ON events (user_id, created_at DESC);
