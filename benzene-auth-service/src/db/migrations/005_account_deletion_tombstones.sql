CREATE TABLE account_deletion_tombstones (
  deletion_request_id UUID PRIMARY KEY
    REFERENCES account_deletion_requests(id) ON DELETE RESTRICT,
  credential_id UUID NOT NULL UNIQUE,
  deleted_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
