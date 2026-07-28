-- 005_torrent_metainfo.sql — cache imutável do metainfo bruto por info hash.
-- Aplicar manualmente: psql "$DATABASE_URL" -f migrations/005_torrent_metainfo.sql

CREATE TABLE IF NOT EXISTS torrent_metadata (
    hash            VARCHAR(64) PRIMARY KEY,
    metadata        JSONB,
    metainfo        BYTEA,
    source          VARCHAR(32),
    attempt_count   INTEGER NOT NULL DEFAULT 0,
    last_attempt_at TIMESTAMPTZ,
    resolved_at     TIMESTAMPTZ,
    last_error      TEXT
);

-- Compatibilidade com a versão anterior da tabela, que guardava apenas JSON.
ALTER TABLE torrent_metadata ALTER COLUMN metadata DROP NOT NULL;
ALTER TABLE torrent_metadata ALTER COLUMN resolved_at DROP DEFAULT;
ALTER TABLE torrent_metadata ADD COLUMN IF NOT EXISTS metainfo BYTEA;
ALTER TABLE torrent_metadata ADD COLUMN IF NOT EXISTS source VARCHAR(32);
ALTER TABLE torrent_metadata ADD COLUMN IF NOT EXISTS attempt_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE torrent_metadata ADD COLUMN IF NOT EXISTS last_attempt_at TIMESTAMPTZ;
ALTER TABLE torrent_metadata ADD COLUMN IF NOT EXISTS last_error TEXT;

CREATE INDEX IF NOT EXISTS torrent_metadata_retry_idx
    ON torrent_metadata(last_attempt_at)
    WHERE metainfo IS NULL;
