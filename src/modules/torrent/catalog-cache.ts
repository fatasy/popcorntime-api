import { and, eq, inArray, sql } from 'drizzle-orm'
import { db } from '../../db'
import { metadata_cache } from '../../types'
import { BackgroundRefreshQueue, readExternalCatalog } from '../../lib/background-refresh'
import { getTV, getSeasonEpisodes, type TmdbSeason } from '../enrichment/tmdb'
import { getAnimeEpisodes, type JikanEpisode } from '../enrichment/myanimelist'

const reportFailure = (key: string, error: unknown) => {
  console.warn(`[episode-catalog] background refresh failed (${key}):`, (error as Error).message)
}
const animeRefreshes = new BackgroundRefreshQueue(1, 5 * 60_000, reportFailure)
const tvRefreshes = new BackgroundRefreshQueue(2, 5 * 60_000, reportFailure)

async function cachedCatalog<T>(
  source: string, key: string, ttlMs: number, fetch: () => Promise<T>,
  valid: (value: unknown) => boolean, force: boolean, coldWaitMs = 0, fallbackKey?: string,
): Promise<T | null> {
  return readExternalCatalog({
    key: `${source}:${key}`, queue: source === 'tmdb' ? tvRefreshes : animeRefreshes, ttlMs, force, coldWaitMs,
    read: async () => {
      const rows = await db.select({ key: metadata_cache.lookup_key,
        response: metadata_cache.response, cached_at: metadata_cache.cached_at })
        .from(metadata_cache).where(and(eq(metadata_cache.source, source),
          inArray(metadata_cache.lookup_key, fallbackKey ? [key, fallbackKey] : [key])))
      const row = rows.find((item) => item.key === key && valid(item.response)) ??
        rows.find((item) => valid(item.response))
      return row ? { value: row.response as T,
        cachedAt: row.key === key ? row.cached_at ?? new Date(0) : new Date(0) } : null
    },
    refresh: async () => {
      const value = await fetch()
      if (!valid(value)) throw new Error('Provider returned an incomplete episode catalog')
      await db.insert(metadata_cache).values({ source, lookup_key: key, response: value })
        .onConflictDoUpdate({ target: [metadata_cache.source, metadata_cache.lookup_key],
          set: { response: value, cached_at: sql`now()` } })
      return value
    },
  })
}

export function cachedAnimeEpisodes(malId: number, force = false): Promise<JikanEpisode[]> {
  return cachedCatalog<JikanEpisode[]>('jikan-episodes', String(malId), 6 * 60 * 60_000,
    () => getAnimeEpisodes(malId), (value) => Array.isArray(value) && value.length > 0, force)
    .then((value) => value ?? [])
}

export function cachedTV(tmdbId: number, force = false): Promise<any | null> {
  return cachedCatalog('tmdb', `tv:${tmdbId}`, 24 * 60 * 60_000,
    () => getTV(tmdbId), (value) => Boolean(value && typeof value === 'object' &&
      Array.isArray((value as { seasons?: unknown }).seasons)), force, 1200, `seasons:${tmdbId}`)
}

export function cachedSeasonEpisodes(tmdbId: number, season: number, force = false): Promise<TmdbSeason | null> {
  return cachedCatalog<TmdbSeason>('tmdb', `tv:${tmdbId}:season:${season}`, 24 * 60 * 60_000,
    () => getSeasonEpisodes(tmdbId, season), (value) => Boolean(value && typeof value === 'object' &&
      Array.isArray((value as TmdbSeason).episodes)), force, 0, `episodes:${tmdbId}:${season}`)
}
