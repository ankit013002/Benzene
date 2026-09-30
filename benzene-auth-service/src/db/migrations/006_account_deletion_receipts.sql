ALTER TABLE account_deletion_requests
  ADD COLUMN receipt_hash BYTEA
    CHECK (receipt_hash IS NULL OR octet_length(receipt_hash) = 32);

CREATE UNIQUE INDEX idx_account_deletion_requests_receipt_hash
  ON account_deletion_requests (receipt_hash)
  WHERE receipt_hash IS NOT NULL;
