CREATE TABLE IF NOT EXISTS kv (
  key        text PRIMARY KEY,
  value      bytea NOT NULL,
  metadata   jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);
