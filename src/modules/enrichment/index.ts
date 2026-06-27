import { and, eq, isNull, sql } from 'drizzle-orm'
import { db } from '../../db'
import { contents, metadata_cache, type Content, type NewContent } from '../../types'
import { normalizeTitle, parseRelease } from '../../lib/parse'
import * as tmdb from './tmdb'
import * as omdb from './omdb'
import * as mal from './myanimelist'

const TMDB_DELAY = 200 // ms between TMDB requests
const JIKAN_DELAY = 350 // ms between Jikan requests

type ContentUpdate = Partial<NewContent>

// ---------------------------------------------------------------------------
// metadata_cache helpers (composite pk: source + lookup_key)
// ---------------------------------------------------------------------------

async function cacheGet(source: string, key: string): Promise<any | null> {
  const lookupKey = key.slice(0, 256)
  const rows = await db
    .select({ response: metadata_cache.response })
    .from(metadata_cache)
    .where(and(eq(metadata_cache.source, source), eq(metadata_cache.lookup_key, lookupKey)))
    .limit(1)
  return rows[0]?.response ?? null
}

async function cacheSet(source: string, key: string, response: any): Promise<void> {
  const lookupKey = key.slice(0, 256)
  await db
    .insert(metadata_cache)
    .values({ source, lookup_key: lookupKey, response })
    .onConflictDoUpdate({
      target: [metadata_cache.source, metadata_cache.lookup_key],
      set: { response, cached_at: sql`now()` },
    })
}

// ---------------------------------------------------------------------------
// Mappers: external payload -> contents column update
// ---------------------------------------------------------------------------

function mapTmdb(d: any, mediaType: string): ContentUpdate {
  const title: string | undefined = d.title ?? d.name
  const date: string = d.release_date ?? d.first_air_date ?? ''
  const year = date ? parseInt(date.slice(0, 4), 10) || null : null
  const genres = (d.genres ?? []).map((g: any) => g.name).filter(Boolean)
  const cast = (d.credits?.cast ?? []).slice(0, 10).map((c: any) => c.name).filter(Boolean)
  const director = (d.credits?.crew ?? []).find((c: any) => c.job === 'Director')?.name ?? null
  const country =
    d.production_countries?.[0]?.name ??
    (Array.isArray(d.origin_country) ? d.origin_country[0] : null) ??
    null
  const runtime =
    d.runtime ?? (Array.isArray(d.episode_run_time) ? d.episode_run_time[0] : null) ?? null
  const imdb = d.external_ids?.imdb_id ?? d.imdb_id ?? null

  return {
    title: title ? title.slice(0, 512) : undefined,
    original_title: (d.original_title ?? d.original_name)?.slice(0, 512) ?? null,
    year,
    synopsis: d.overview || null,
    genres: genres.length ? genres : null,
    rating: d.vote_average != null ? String(d.vote_average) : null,
    poster_url: tmdb.tmdbImage(d.poster_path),
    backdrop_url: tmdb.tmdbImage(d.backdrop_path, 'w780'),
    cast_members: cast.length ? cast : null,
    director: director ? String(director).slice(0, 256) : null,
    duration_min: typeof runtime === 'number' ? runtime : null,
    country: country ? String(country).slice(0, 128) : null,
    tmdb_id: typeof d.id === 'number' ? d.id : null,
    imdb_id: imdb ? String(imdb).slice(0, 16) : null,
  }
}

function mapOmdb(d: omdb.OmdbResult): ContentUpdate {
  const year = d.Year ? parseInt(d.Year.slice(0, 4), 10) || null : null
  const runtime = d.Runtime?.match(/(\d+)/)
  const ok = (v?: string) => (v && v !== 'N/A' ? v : null)
  return {
    title: ok(d.Title)?.slice(0, 512),
    year,
    synopsis: ok(d.Plot),
    genres: ok(d.Genre) ? d.Genre!.split(',').map((s) => s.trim()) : null,
    rating: ok(d.imdbRating),
    poster_url: ok(d.Poster),
    duration_min: runtime ? parseInt(runtime[1]!, 10) : null,
    country: ok(d.Country)?.slice(0, 128) ?? null,
    director: ok(d.Director)?.slice(0, 256) ?? null,
    cast_members: ok(d.Actors) ? d.Actors!.split(',').map((s) => s.trim()) : null,
    imdb_id: ok(d.imdbID)?.slice(0, 16) ?? null,
  }
}

function mapJikan(a: mal.JikanAnime): ContentUpdate {
  const year = a.year ?? a.aired?.prop?.from?.year ?? null
  const durMatch = a.duration?.match(/(\d+)\s*min/i)
  const poster = a.images?.jpg?.large_image_url ?? a.images?.jpg?.image_url ?? null
  return {
    title: (a.title_english ?? a.title)?.slice(0, 512),
    original_title: (a.title_japanese ?? a.title)?.slice(0, 512) ?? null,
    year: year ?? null,
    synopsis: a.synopsis ?? null,
    genres: a.genres?.length ? a.genres.map((g) => g.name) : null,
    rating: a.score != null ? String(a.score) : null,
    poster_url: poster,
    duration_min: durMatch ? parseInt(durMatch[1]!, 10) : null,
    mal_id: a.mal_id,
  }
}

// ---------------------------------------------------------------------------
// Per-source enrichment strategies (cache-aware, rate-limited)
// ---------------------------------------------------------------------------

async function enrichViaTmdb(query: string, content: Content): Promise<ContentUpdate | null> {
  const searchKey = `multi:${query}:${content.year ?? ''}`
  let results = await cacheGet('tmdb', searchKey)
  if (results == null) {
    results = await tmdb.searchMulti(query)
    await Bun.sleep(TMDB_DELAY)
    await cacheSet('tmdb', searchKey, results)
  }
  if (!Array.isArray(results) || results.length === 0) return null

  const wantTv = content.type === 'series'
  let pick: any =
    results.find((r: any) => (wantTv ? r.media_type === 'tv' : r.media_type === 'movie')) ??
    results[0]
  if (content.year) {
    const byYear = results.find((r: any) => {
      const d: string = r.release_date ?? r.first_air_date ?? ''
      return d.startsWith(String(content.year))
    })
    if (byYear) pick = byYear
  }

  const detailKey = `${pick.media_type}:${pick.id}`
  let details = await cacheGet('tmdb', detailKey)
  if (details == null) {
    details = pick.media_type === 'tv' ? await tmdb.getTV(pick.id) : await tmdb.getMovie(pick.id)
    await Bun.sleep(TMDB_DELAY)
    await cacheSet('tmdb', detailKey, details)
  }
  return mapTmdb(details, pick.media_type)
}

async function enrichViaOmdb(query: string, content: Content): Promise<ContentUpdate | null> {
  const key = `t:${query}:${content.year ?? ''}`
  let data = await cacheGet('omdb', key)
  if (data == null) {
    data = await omdb.searchByTitle(query, content.year)
    await cacheSet('omdb', key, data ?? { Response: 'False' })
  }
  if (!data || data.Response === 'False') return null
  return mapOmdb(data as omdb.OmdbResult)
}

async function enrichViaJikan(query: string, _content: Content): Promise<ContentUpdate | null> {
  const key = `search:${query}`
  let results = await cacheGet('jikan', key)
  if (results == null) {
    results = await mal.searchAnime(query)
    await Bun.sleep(JIKAN_DELAY)
    await cacheSet('jikan', key, results)
  }
  if (!Array.isArray(results) || results.length === 0) {
    // normalize + retry once
    const norm = normalizeTitle(query)
    if (norm && norm !== query) {
      results = await mal.searchAnime(norm)
      await Bun.sleep(JIKAN_DELAY)
      await cacheSet('jikan', `search:${norm}`, results)
    }
  }
  if (!Array.isArray(results) || results.length === 0) return null
  return mapJikan(results[0])
}

async function applyUpdate(id: number, update: ContentUpdate): Promise<void> {
  await db
    .update(contents)
    .set({ ...update, enriched_at: sql`now()`, updated_at: sql`now()` })
    .where(eq(contents.id, id))
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Enrich a single content row:
 * clean title -> check cache -> TMDB/Jikan -> OMDb fallback -> normalize+retry.
 * Returns true if metadata was found and saved.
 */
export async function enrichContent(content: Content): Promise<boolean> {
  const raw = content.title?.trim()
  if (!raw) return false

  // Extract clean title using the same parser that powers grouping
  const parsed = parseRelease(raw)
  const cleaned = parsed.title || raw

  try {
    if (content.type === 'anime') {
      const viaJikan = await enrichViaJikan(cleaned, content)
      if (viaJikan) {
        await applyUpdate(content.id, viaJikan)
        return true
      }
      return false
    }

    // movies & series -> TMDB first
    const viaTmdb = await enrichViaTmdb(cleaned, content)
    if (viaTmdb) {
      await applyUpdate(content.id, viaTmdb)
      return true
    }

    // OMDb fallback
    const viaOmdb = await enrichViaOmdb(cleaned, content)
    if (viaOmdb) {
      await applyUpdate(content.id, viaOmdb)
      return true
    }

    // normalize + retry TMDB once with a cleaned-up title
    const norm = normalizeTitle(cleaned)
    if (norm && norm !== cleaned.toLowerCase()) {
      const retry = await enrichViaTmdb(norm, content)
      if (retry) {
        await applyUpdate(content.id, retry)
        return true
      }
    }
    return false
  } catch (err) {
    console.warn(`[enrich] content ${content.id} ("${content.title}") failed:`, (err as Error).message)
    return false
  }
}

/** Enrich up to `limit` contents that have not been enriched yet. */
export async function enrichPending(limit = 50): Promise<number> {
  const pending = await db
    .select()
    .from(contents)
    .where(isNull(contents.enriched_at))
    .limit(limit)

  let enriched = 0
  for (const content of pending) {
    const ok = await enrichContent(content)
    if (ok) {
      enriched++
      console.log(`[enrich] ✓ ${content.type} "${content.title}"`)
    } else {
      console.log(`[enrich] – no match for ${content.type} "${content.title}"`)
    }
  }
  return enriched
}
