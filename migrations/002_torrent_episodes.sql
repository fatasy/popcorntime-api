CREATE TABLE IF NOT EXISTS torrent_episodes (
    content_id INTEGER NOT NULL REFERENCES contents(id) ON DELETE CASCADE,
    torrent_hash VARCHAR(64) NOT NULL,
    season INTEGER NOT NULL,
    episode INTEGER NOT NULL,
    file_index INTEGER,
    inferred BOOLEAN DEFAULT FALSE,
    resolved_at TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (content_id, torrent_hash, season, episode)
);
