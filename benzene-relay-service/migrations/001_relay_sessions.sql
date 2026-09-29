CREATE TABLE IF NOT EXISTS relay_sessions (
  session_id uuid PRIMARY KEY,
  storage_hash char(64) NOT NULL CHECK (storage_hash ~ '^[a-f0-9]{64}$'),
  device_id uuid NOT NULL,
  operation text NOT NULL CHECK (operation IN ('get', 'put')),
  expires_at bigint NOT NULL,
  max_bytes bigint NOT NULL CHECK (max_bytes > 0),
  bytes_forwarded bigint NOT NULL DEFAULT 0 CHECK (bytes_forwarded >= 0),
  state text NOT NULL CHECK (state IN ('waiting', 'paired', 'closed')),
  owner_instance text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (bytes_forwarded <= max_bytes)
);

CREATE INDEX IF NOT EXISTS relay_sessions_active_expiry_idx
  ON relay_sessions (expires_at)
  WHERE state <> 'closed';

CREATE TABLE IF NOT EXISTS relay_ticket_claims (
  ticket_id uuid PRIMARY KEY,
  session_id uuid NOT NULL REFERENCES relay_sessions(session_id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('node', 'client')),
  expires_at bigint NOT NULL,
  claimed_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (session_id, role)
);

CREATE INDEX IF NOT EXISTS relay_ticket_claims_expiry_idx
  ON relay_ticket_claims (expires_at);
