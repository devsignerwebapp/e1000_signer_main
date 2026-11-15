-- AI legal analyses (Pro). Cached per PDF content hash + language so the same document
-- (e.g. a template many clients open) is analysed — and paid for — only once.
CREATE TABLE document_analyses (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  file_hash      VARCHAR(64) NOT NULL,          -- sha256 of the PDF bytes
  lang           VARCHAR(5)  NOT NULL DEFAULT 'en',
  status         VARCHAR(16) NOT NULL DEFAULT 'pending',   -- pending | completed | failed
  result         JSONB,
  error          TEXT,
  model          VARCHAR(64),
  input_tokens   INT,
  output_tokens  INT,
  source         VARCHAR(16) NOT NULL,          -- document | template
  source_id      UUID,
  requested_by   UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at   TIMESTAMPTZ
);
CREATE INDEX document_analyses_lookup_idx ON document_analyses (file_hash, lang, created_at DESC);
ALTER TABLE document_analyses ENABLE ROW LEVEL SECURITY;
