ALTER TABLE account_deletion_requests
  DROP CONSTRAINT account_deletion_requests_current_phase_check;

ALTER TABLE account_deletion_requests
  ADD CONSTRAINT account_deletion_requests_current_phase_check
  CHECK (current_phase IN (
    'awaiting_cleanup_operator',
    'user_profile',
    'stored_objects',
    'device_data',
    'vault_metadata',
    'billing_records',
    'backups_and_logs',
    'auth_credential',
    'complete'
  ));
