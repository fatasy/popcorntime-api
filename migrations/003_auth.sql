-- 003_auth.sql — contas, perfis, refresh tokens e biblioteca (lista + progresso) por perfil.
-- Idempotente (CREATE TABLE IF NOT EXISTS). Aplicar manual: psql "$DATABASE_URL" -f migrations/003_auth.sql

CREATE TABLE IF NOT EXISTS users (
    id            SERIAL PRIMARY KEY,
    email         VARCHAR(320) NOT NULL,
    email_norm    VARCHAR(320) NOT NULL UNIQUE,        -- lower(trim(email))
    password_hash TEXT NOT NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS profiles (
    id         SERIAL PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name       VARCHAR(64) NOT NULL,
    avatar     VARCHAR(32),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS profiles_user_idx ON profiles(user_id);

CREATE TABLE IF NOT EXISTS refresh_tokens (
    id          SERIAL PRIMARY KEY,
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash  CHAR(64) NOT NULL UNIQUE,              -- sha256 hex; nunca o token cru
    family_id   UUID NOT NULL,
    expires_at  TIMESTAMPTZ NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    replaced_at TIMESTAMPTZ,
    revoked_at  TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS refresh_user_idx   ON refresh_tokens(user_id);
CREATE INDEX IF NOT EXISTS refresh_family_idx ON refresh_tokens(family_id);

CREATE TABLE IF NOT EXISTS profile_favorites (
    profile_id INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    content_id INTEGER NOT NULL REFERENCES contents(id) ON DELETE CASCADE,
    title      VARCHAR(512),
    poster     TEXT,
    type       VARCHAR(16),
    year       INTEGER,
    added_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (profile_id, content_id)
);

CREATE TABLE IF NOT EXISTS profile_progress (
    profile_id INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    cw_key     TEXT NOT NULL,                          -- == makeCwKey(magnet, fileIndex)
    content_id INTEGER REFERENCES contents(id) ON DELETE SET NULL,
    title      VARCHAR(512) NOT NULL,
    poster     TEXT,
    magnet     TEXT NOT NULL,
    file_index INTEGER NOT NULL,
    position   INTEGER NOT NULL,
    duration   INTEGER NOT NULL,
    season     INTEGER,
    episode    INTEGER,
    deleted    BOOLEAN NOT NULL DEFAULT FALSE,
    updated_at TIMESTAMPTZ NOT NULL,                   -- controlado pelo cliente (LWW)
    PRIMARY KEY (profile_id, cw_key)
);
CREATE INDEX IF NOT EXISTS pp_profile_updated_idx ON profile_progress(profile_id, updated_at DESC);
