-- Reference migration for @sabeesoft/idempotix-typeorm (PostgreSQL).
-- Apply it with your own migration tooling (TypeORM migrations, Flyway, ...).
-- Rename the table if you pass a different `tableName` to the store.

CREATE TABLE IF NOT EXISTS idempotency_keys (
  scope         text        NOT NULL,
  key           text        NOT NULL,
  request_hash  text        NOT NULL,
  status        text        NOT NULL CHECK (status IN ('processing', 'completed')),
  response_code integer,
  response_body jsonb,
  locked_until  timestamptz(3) NOT NULL,
  created_at    timestamptz(3) NOT NULL DEFAULT now(),
  PRIMARY KEY (scope, key)
);

CREATE INDEX IF NOT EXISTS idempotency_keys_locked_until_idx
  ON idempotency_keys (locked_until);

-- Cleanup of expired rows (run from a scheduled job; the store never does this on its own):
-- DELETE FROM idempotency_keys WHERE locked_until < now();
