-- Data real de estreia/lançamento usada pelas fileiras mensais do app.
-- Idempotente. Aplicar manualmente antes de subir a API que referencia a coluna.

ALTER TABLE contents
  ADD COLUMN IF NOT EXISTS release_date date;

CREATE INDEX IF NOT EXISTS idx_contents_release_date
  ON contents (release_date DESC)
  WHERE canonical_content_id IS NULL;

-- Os detalhes do TMDB já foram armazenados pelo enriquecimento. Reaproveita o
-- cache para preencher o catálogo existente sem consumir novamente a API.
UPDATE contents AS c
SET release_date = CASE
  WHEN c.type = 'movie' THEN substring(mc.response ->> 'release_date' FROM 1 FOR 10)::date
  ELSE COALESCE(
    (
      SELECT max(substring(season.value ->> 'air_date' FROM 1 FOR 10)::date)
      FROM jsonb_array_elements(
        CASE
          WHEN jsonb_typeof(mc.response -> 'seasons') = 'array'
            THEN mc.response -> 'seasons'
          ELSE '[]'::jsonb
        END
      ) AS season(value)
      WHERE COALESCE(season.value ->> 'season_number', '0') ~ '^[0-9]+$'
        AND (season.value ->> 'season_number')::integer > 0
        AND COALESCE(season.value ->> 'air_date', '')
          ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}'
    ),
    substring(mc.response ->> 'first_air_date' FROM 1 FOR 10)::date
  )
END
FROM metadata_cache AS mc
WHERE c.release_date IS NULL
  AND c.tmdb_id IS NOT NULL
  AND mc.source = 'tmdb'
  AND mc.lookup_key = (
    CASE WHEN c.type = 'movie' THEN 'movie:' ELSE 'tv:' END || c.tmdb_id::text
  )
  AND COALESCE(mc.response ->> 'release_date', mc.response ->> 'first_air_date', '')
    ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}';

-- O cache do Jikan guarda arrays de resultados. Escolhe a resposta mais
-- recente por MAL id e extrai o início oficial da exibição.
WITH jikan_dates AS (
  SELECT DISTINCT ON ((item.value ->> 'mal_id')::integer)
    (item.value ->> 'mal_id')::integer AS mal_id,
    substring(item.value #>> '{aired,from}' FROM 1 FOR 10)::date AS release_date
  FROM metadata_cache AS mc
  CROSS JOIN LATERAL jsonb_array_elements(
    CASE WHEN jsonb_typeof(mc.response) = 'array' THEN mc.response ELSE '[]'::jsonb END
  ) AS item(value)
  WHERE mc.source = 'jikan'
    AND item.value ->> 'mal_id' ~ '^[0-9]+$'
    AND COALESCE(item.value #>> '{aired,from}', '')
      ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}'
  ORDER BY (item.value ->> 'mal_id')::integer, mc.cached_at DESC
)
UPDATE contents AS c
SET release_date = j.release_date
FROM jikan_dates AS j
WHERE c.release_date IS NULL
  AND c.mal_id = j.mal_id;

-- Um anime canônico representa todas as temporadas; sua novidade é a estreia
-- da temporada mais recente, não a estreia histórica da primeira temporada.
WITH jikan_dates AS (
  SELECT DISTINCT ON ((item.value ->> 'mal_id')::integer)
    (item.value ->> 'mal_id')::integer AS mal_id,
    substring(item.value #>> '{aired,from}' FROM 1 FOR 10)::date AS release_date
  FROM metadata_cache AS mc
  CROSS JOIN LATERAL jsonb_array_elements(
    CASE WHEN jsonb_typeof(mc.response) = 'array' THEN mc.response ELSE '[]'::jsonb END
  ) AS item(value)
  WHERE mc.source = 'jikan'
    AND item.value ->> 'mal_id' ~ '^[0-9]+$'
    AND COALESCE(item.value #>> '{aired,from}', '')
      ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}'
), anime_latest AS (
  SELECT entry.content_id, max(j.release_date) AS release_date
  FROM anime_franchise_entries AS entry
  INNER JOIN jikan_dates AS j ON j.mal_id = entry.mal_id
  GROUP BY entry.content_id
)
UPDATE contents AS c
SET release_date = latest.release_date
FROM anime_latest AS latest
WHERE c.id = latest.content_id;

-- Fallback para títulos enriquecidos apenas pelo OMDb.
UPDATE contents AS c
SET release_date = to_date(mc.response ->> 'Released', 'DD Mon YYYY')
FROM metadata_cache AS mc
WHERE c.release_date IS NULL
  AND c.imdb_id IS NOT NULL
  AND mc.source = 'omdb'
  AND mc.response ->> 'imdbID' = c.imdb_id
  AND COALESCE(mc.response ->> 'Released', '')
    ~ '^[0-9]{1,2} [A-Za-z]{3} [0-9]{4}$';
