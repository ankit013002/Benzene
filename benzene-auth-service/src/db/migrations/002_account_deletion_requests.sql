ALTER TABLE credentials
  ADD COLUMN account_status TEXT NOT NULL DEFAULT 'active'
  CHECK (account_status IN ('active', 'deletion_requested'));

CREATE TABLE account_deletion_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  credential_id UUID UNIQUE REFERENCES credentials(id) ON DELETE SET NULL,
  idempotency_key TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'cleanup_pending'
    CHECK (status IN ('cleanup_pending', 'blocked', 'completed')),
  current_phase TEXT NOT NULL DEFAULT 'awaiting_cleanup_operator'
    CHECK (current_phase IN (
      'awaiting_cleanup_operator',
      'user_profile',
      'vault_metadata',
      'stored_objects',
      'device_data',
      'billing_records',
      'backups_and_logs',
      'complete'
    )),
  requested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,
  last_error_code TEXT
);

CREATE INDEX idx_account_deletion_requests_pending
  ON account_deletion_requests (requested_at)
  WHERE status IN ('cleanup_pending', 'blocked');
