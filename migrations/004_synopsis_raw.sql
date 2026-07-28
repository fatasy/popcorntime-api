-- 004_synopsis_raw.sql — coluna de backup para sinopses originais (inglês)
-- A coluna synopsis passará a conter a tradução (pt-BR); synopsis_raw preserva o original.
-- Idempotente. Aplicar: psql "$DATABASE_URL" -f migrations/004_synopsis_raw.sql

ALTER TABLE contents ADD COLUMN IF NOT EXISTS synopsis_raw text;
