ALTER TABLE account_deletion_requests
  ADD COLUMN lease_token UUID,
  ADD COLUMN lease_expires_at TIMESTAMPTZ,
  ADD COLUMN retry_after TIMESTAMPTZ,
  ADD COLUMN phase_started_at TIMESTAMPTZ,
  ADD COLUMN attempt_count INTEGER NOT NULL DEFAULT 0
    CHECK (attempt_count >= 0);

CREATE INDEX idx_account_deletion_requests_claimable
  ON account_deletion_requests (requested_at, id)
  WHERE status IN ('cleanup_pending', 'blocked')
    AND current_phase <> 'complete';
