-- 007_episode_metadata.sql — metadado + arte por episódio (TMDB/Jikan/TVMaze/TheTVDB)
-- Aplicar manualmente: psql "$DATABASE_URL" -f migrations/007_episode_metadata.sql
--
-- Provedores de metadado: TMDB (título pt-BR/sinopse/still), Jikan-MAL (título,
-- data, filler/recap), TVMaze (imagem horizontal por episódio) e TheTVDB
-- (arte por episódio, opcional/chave própria). A ORDEM de precedência e a
-- atribuição obrigatória de cada fonte ficam em `src/modules/torrent/episode-types.ts`.
--
-- `image_kind` é o contrato estável para o app:
--   'still'    → still_url é a arte DESTE episódio (provider em image_source)
--   'fallback' → não há still; thumbnail_url é o poster/backdrop do conteúdo
--   'none'     → nenhuma imagem: usar placeholder local (URLs nulas)
-- `image_match` registra como o provedor foi vinculado (tmdb|imdb|thetvdb|title)
-- para auditar casamentos por nome (só usados em anime, com guardas estritas).
--
-- Por que existe: `GET /catalog/:id/episodes` resolvia os metadados de episódio
-- em memória a cada request, e SÓ via TMDB. Animes keyed por `mal_id` (a grande
-- maioria: 219 de 721 em set/2026) não têm `tmdb_id` e caíam no fallback
-- heurístico — episódio sem título, sem data e sem imagem. Esta tabela persiste
-- o metadado externo (título, sinopse, data, duração, still/thumbnail, filler)
-- para ser servido pelo endpoint sem nova chamada ao provedor a cada request.
--
-- Chave: (content_id, season, episode). `source` indica o provedor que preencheu
-- o metadado de texto (o de MAIOR precedência que teve dado):
--   'tmdb'    → título pt-BR, sinopse, duração e STILL por episódio (still_path)
--   'jikan'   → título/data de exibição/filler/recap (MAL não expõe imagem por
--               episódio; a arte vem do TVMaze/TMDB quando houver)
--   'tvmaze'  → título/sinopse/data + IMAGEM horizontal por episódio (CC BY-SA)
--   'thetvdb' → título/sinopse/data + arte por episódio (opcional, chave própria)
--   'none'    → passada concluída sem nenhum metadado para este episódio
--               (ausência EXPLÍCITA: evita reconsultar a cada request)
--
-- Linha com `source='none'`/`image_kind='none'` é resultado definitivo de uma
-- passada que completou; o que ficou pendente é controlado em `metadata_cache`
-- (`partial:content:<id>` + `miss:content:<id>:<provider>`).

CREATE TABLE IF NOT EXISTS episode_metadata (
    content_id        INTEGER NOT NULL REFERENCES contents(id),
    season            INTEGER NOT NULL,
    episode           INTEGER NOT NULL,
    source            VARCHAR(16) NOT NULL,
    source_episode_id VARCHAR(64),
    title             VARCHAR(512),
    title_original    VARCHAR(512),
    overview          TEXT,
    air_date          DATE,
    runtime_sec       INTEGER,
    score             NUMERIC(4,2),
    filler            BOOLEAN,
    recap             BOOLEAN,
    still_path        VARCHAR(256),
    still_url         TEXT,
    thumbnail_url     TEXT,
    image_source      VARCHAR(16),   -- tmdb | tvmaze | thetvdb
    image_kind        VARCHAR(16),   -- still | fallback | none
    image_match       VARCHAR(16),   -- tmdb | imdb | thetvdb | title
    image_credit      VARCHAR(128),  -- atribuição exigida pela fonte da imagem
    image_credit_url  VARCHAR(256),  -- link de atribuição (TVMaze/TheTVDB exigem)
    image_license     VARCHAR(64),   -- ex.: CC BY-SA 4.0 (TVMaze)
    fetched_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (content_id, season, episode)
);

CREATE INDEX IF NOT EXISTS episode_metadata_fetched_idx ON episode_metadata(fetched_at);
