import {
  pgTable,
  serial,
  varchar,
  text,
  integer,
  bigint,
  boolean,
  timestamp,
  decimal,
  jsonb,
  primaryKey,
  uuid,
} from 'drizzle-orm/pg-core'

// NOTE: these tables ALREADY exist in the database. These Drizzle definitions
// are used only for type-safe queries/inserts — never for migrations here.

export const torrents = pgTable('torrents', {
  id: serial('id').primaryKey(),
  source: varchar('source', { length: 32 }).notNull(),
  hash: varchar('hash', { length: 64 }).notNull().unique(),
  title: varchar('title', { length: 512 }).notNull(),
  magnet_link: text('magnet_link').notNull(),
  seeds: integer('seeds').default(0),
  leechers: integer('leechers').default(0),
  size_bytes: bigint('size_bytes', { mode: 'number' }),
  uploader: varchar('uploader', { length: 128 }),
  category: varchar('category', { length: 32 }),
  published_at: timestamp('published_at', { withTimezone: true }),
  collected_at: timestamp('collected_at', { withTimezone: true }).defaultNow(),
  last_seen_at: timestamp('last_seen_at', { withTimezone: true }).defaultNow(),
  file_list: jsonb('file_list'),
  quality_from_files: varchar('quality_from_files', { length: 32 }),
})

export const contents = pgTable('contents', {
  id: serial('id').primaryKey(),
  type: varchar('type', { length: 16 }).notNull(),
  title: varchar('title', { length: 512 }).notNull(),
  original_title: varchar('original_title', { length: 512 }),
  year: integer('year'),
  synopsis: text('synopsis'),
  genres: text('genres').array(),
  rating: decimal('rating'),
  poster_url: text('poster_url'),
  backdrop_url: text('backdrop_url'),
  cast_members: text('cast_members').array(),
  director: varchar('director', { length: 256 }),
  duration_min: integer('duration_min'),
  country: varchar('country', { length: 128 }),
  season: integer('season'),
  episode: integer('episode'),
  tmdb_id: integer('tmdb_id'),
  imdb_id: varchar('imdb_id', { length: 16 }),
  mal_id: integer('mal_id'),
  enriched_at: timestamp('enriched_at', { withTimezone: true }),
  created_at: timestamp('created_at', { withTimezone: true }).defaultNow(),
  updated_at: timestamp('updated_at', { withTimezone: true }).defaultNow(),
  last_gap_fill_at: timestamp('last_gap_fill_at', { withTimezone: true }),
})

export const content_torrents = pgTable(
  'content_torrents',
  {
    content_id: integer('content_id')
      .notNull()
      .references(() => contents.id),
    torrent_id: integer('torrent_id')
      .notNull()
      .references(() => torrents.id),
    is_primary: boolean('is_primary').default(false),
    season: integer('season'),
    episode: integer('episode'),
    added_at: timestamp('added_at', { withTimezone: true }).defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.content_id, table.torrent_id] })],
)

export const metadata_cache = pgTable(
  'metadata_cache',
  {
    source: varchar('source', { length: 32 }).notNull(),
    lookup_key: varchar('lookup_key', { length: 256 }).notNull(),
    response: jsonb('response').notNull(),
    cached_at: timestamp('cached_at', { withTimezone: true }).defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.source, table.lookup_key] })],
)

// Episode resolution cache: maps torrents to specific episodes
export const torrent_episodes = pgTable(
  'torrent_episodes',
  {
    content_id: integer('content_id')
      .notNull()
      .references(() => contents.id),
    torrent_hash: varchar('torrent_hash', { length: 64 }).notNull(),
    season: integer('season').notNull(),
    episode: integer('episode').notNull(),
    file_index: integer('file_index'),
    inferred: boolean('inferred').default(false),
    resolved_at: timestamp('resolved_at', { withTimezone: true }).defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.content_id, table.torrent_hash, table.season, table.episode] }),
  ],
)

// Torrent metadata cache: resolved file lists from info dict
export const torrent_metadata = pgTable(
  'torrent_metadata',
  {
    hash: varchar('hash', { length: 64 }).primaryKey(),
    metadata: jsonb('metadata').notNull(),
    resolved_at: timestamp('resolved_at', { withTimezone: true }).defaultNow(),
  },
)

export type Torrent = typeof torrents.$inferSelect
export type NewTorrent = typeof torrents.$inferInsert
export type Content = typeof contents.$inferSelect
export type NewContent = typeof contents.$inferInsert
export type ContentTorrent = typeof content_torrents.$inferSelect
export type NewContentTorrent = typeof content_torrents.$inferInsert

// ─── Auth: contas, perfis, refresh tokens (criadas por migrations/003_auth.sql) ───

export const users = pgTable('users', {
  id: serial('id').primaryKey(),
  email: varchar('email', { length: 320 }).notNull(),
  email_norm: varchar('email_norm', { length: 320 }).notNull().unique(),
  password_hash: text('password_hash').notNull(),
  created_at: timestamp('created_at', { withTimezone: true }).defaultNow(),
  updated_at: timestamp('updated_at', { withTimezone: true }).defaultNow(),
})

export const profiles = pgTable(
  'profiles',
  {
    id: serial('id').primaryKey(),
    user_id: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: varchar('name', { length: 64 }).notNull(),
    avatar: varchar('avatar', { length: 32 }),
    created_at: timestamp('created_at', { withTimezone: true }).defaultNow(),
  },
)

export const refresh_tokens = pgTable('refresh_tokens', {
  id: serial('id').primaryKey(),
  user_id: integer('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  token_hash: varchar('token_hash', { length: 64 }).notNull().unique(),
  family_id: uuid('family_id').notNull(),
  expires_at: timestamp('expires_at', { withTimezone: true }).notNull(),
  created_at: timestamp('created_at', { withTimezone: true }).defaultNow(),
  replaced_at: timestamp('replaced_at', { withTimezone: true }),
  revoked_at: timestamp('revoked_at', { withTimezone: true }),
})

export const profile_favorites = pgTable(
  'profile_favorites',
  {
    profile_id: integer('profile_id')
      .notNull()
      .references(() => profiles.id, { onDelete: 'cascade' }),
    content_id: integer('content_id')
      .notNull()
      .references(() => contents.id, { onDelete: 'cascade' }),
    title: varchar('title', { length: 512 }),
    poster: text('poster'),
    type: varchar('type', { length: 16 }),
    year: integer('year'),
    added_at: timestamp('added_at', { withTimezone: true }).defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.profile_id, table.content_id] })],
)

export const profile_progress = pgTable(
  'profile_progress',
  {
    profile_id: integer('profile_id')
      .notNull()
      .references(() => profiles.id, { onDelete: 'cascade' }),
    cw_key: text('cw_key').notNull(),
    content_id: integer('content_id').references(() => contents.id, { onDelete: 'set null' }),
    title: varchar('title', { length: 512 }).notNull(),
    poster: text('poster'),
    magnet: text('magnet').notNull(),
    file_index: integer('file_index').notNull(),
    position: integer('position').notNull(),
    duration: integer('duration').notNull(),
    season: integer('season'),
    episode: integer('episode'),
    deleted: boolean('deleted').notNull().default(false),
    updated_at: timestamp('updated_at', { withTimezone: true }).notNull(),
  },
  (table) => [primaryKey({ columns: [table.profile_id, table.cw_key] })],
)

export type User = typeof users.$inferSelect
export type NewUser = typeof users.$inferInsert
export type Profile = typeof profiles.$inferSelect
export type NewProfile = typeof profiles.$inferInsert
export type RefreshToken = typeof refresh_tokens.$inferSelect
export type ProfileFavorite = typeof profile_favorites.$inferSelect
export type ProfileProgress = typeof profile_progress.$inferSelect
