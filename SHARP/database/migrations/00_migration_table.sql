DROP TYPE IF EXISTS migration_status;

CREATE TYPE migration_status AS ENUM (
    'scheduled', -- Initial state
    'running', -- Migration in progress
    'failed', -- Migration failed
    'migrated', -- Successfully migrated
);

CREATE TABLE IF NOT EXISTS migrations (
   id TEXT PRIMARY KEY,
   status migration_status DEFAULT 'scheduled',
);
