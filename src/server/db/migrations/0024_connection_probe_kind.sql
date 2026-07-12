ALTER TABLE connection_probe ADD COLUMN kind TEXT NOT NULL DEFAULT 'connectivity' CHECK (kind IN ('connectivity','model'));
ALTER TABLE connection_probe ADD COLUMN model TEXT;
