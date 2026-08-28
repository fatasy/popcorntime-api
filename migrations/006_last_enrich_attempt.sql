-- 006_last_enrich_attempt.sql
-- Rastreia a última tentativa de enriquecimento de cada content.
-- Permite que enrichPending PULE itens já tentados recentemente (janela de 24h),
-- evitando que apibay-packs sem match monopolizem o orçamento e privem o
-- conteúdo real recém-descoberto de ser enriquecido.
ALTER TABLE contents ADD COLUMN IF NOT EXISTS last_enrich_attempt_at timestamp with time zone;