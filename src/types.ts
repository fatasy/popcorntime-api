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
