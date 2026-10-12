-- Somente referências/URLs: a API não baixa, hospeda ou faz proxy de vídeo.
CREATE TABLE IF NOT EXISTS http_streams (
  id serial PRIMARY KEY,
  content_id integer NOT NULL REFERENCES contents(id) ON DELETE CASCADE,
  season integer NOT NULL CHECK (season >= 1),
  episode integer NOT NULL CHECK (episode >= 1),
  provider varchar(32) NOT NULL,
  page_url text NOT NULL,
  title varchar(512) NOT NULL,
  audio_type varchar(16) NOT NULL CHECK (audio_type IN ('dubbed', 'subbed')),
  stream_url text,
  quality varchar(32),
  resolved_at timestamp with time zone,
  collected_at timestamp with time zone NOT NULL DEFAULT now(),
  UNIQUE (content_id, season, episode, provider, page_url)
);
CREATE INDEX IF NOT EXISTS http_streams_episode_idx
  ON http_streams(content_id, season, episode);

ALTER TABLE profile_progress ADD COLUMN IF NOT EXISTS stream_id integer;
ALTER TABLE profile_progress ADD COLUMN IF NOT EXISTS stream_url text;
