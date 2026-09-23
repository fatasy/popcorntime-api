-- Um anime no catálogo representa a obra inteira. Cada temporada/parte do MAL
-- continua identificável, mas deixa de virar um título separado na vitrine.
ALTER TABLE contents
  ADD COLUMN IF NOT EXISTS canonical_content_id integer
  REFERENCES contents(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS contents_canonical_content_id_idx
  ON contents(canonical_content_id);

CREATE TABLE IF NOT EXISTS anime_franchise_entries (
  content_id integer NOT NULL REFERENCES contents(id) ON DELETE CASCADE,
  mal_id integer NOT NULL UNIQUE,
  season_number integer NOT NULL,
  part_number integer NOT NULL DEFAULT 1,
  episode_offset integer NOT NULL DEFAULT 0,
  title varchar(512) NOT NULL,
  title_english varchar(512),
  title_japanese varchar(512),
  year integer,
  episode_count integer,
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  PRIMARY KEY (content_id, mal_id)
);

CREATE INDEX IF NOT EXISTS anime_franchise_entries_content_season_idx
  ON anime_franchise_entries(content_id, season_number, part_number);
