import { db } from '../db'
import { contents } from '../types'
import { eq, and, or, isNull } from 'drizzle-orm'
import { collectTorrentsByQuery, type Category } from '../modules/collection'
import {
  getNowPlayingMovies,
  getPopularMovies,
  getTrendingMovies,
  getPopularTV,
  getTrendingTV,
  getOnTheAirTV,
  discoverAnime,
  getTV,
  tmdbImage,
} from '../modules/enrichment/tmdb'
import { getSeasonNow, getTopAiring } from '../modules/enrichment/myanimelist'
import type { JikanAnime } from '../modules/enrichment/myanimelist'

// ─── helpers ────────────────────────────────────────────────────────

function normalizeTitle(t: string) {
  return t
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]/g, '')
}

function extractYear(dateStr?: string): number | null {
  if (!dateStr) return null
  const m = dateStr.match(/^(\d{4})/)
  return m ? Number(m[1]) : null
}

function daysAgo(dateStr?: string): number {
  if (!dateStr) return 999
  return (Date.now() - new Date(dateStr).getTime()) / 86400000
}

// ─── existence check ────────────────────────────────────────────────

async function contentExists(
  type: string,
  title: string,
  year: number | null,
  tmdbId: number | null,
  malId: number | null,
): Promise<boolean> {
  const conditions = []

  if (tmdbId != null) {
    conditions.push(and(eq(contents.tmdb_id, tmdbId), eq(contents.type, type)))
  }
  if (malId != null) {
    conditions.push(and(eq(contents.mal_id, malId), eq(contents.type, type)))
  }

  if (conditions.length) {
    const rows = await db
      .select({ id: contents.id })
      .from(contents)
      .where(or(...conditions))
      .limit(1)
    if (rows.length) return true
  }

  // Fallback: normalized title + year
  if (year) {
    // We can't easily match by normalized title in SQL, so match by exact title + year
    const rows = await db
      .select({ id: contents.id })
      .from(contents)
      .where(
        and(
          eq(contents.type, type),
          eq(contents.title, title.slice(0, 512)),
          eq(contents.year, year),
        ),
      )
      .limit(1)
    if (rows.length) return true
  }

  return false
}

// ─── insert ─────────────────────────────────────────────────────────

async function insertContent(
  type: string,
  title: string,
  year: number | null,
  tmdbId: number | null,
  malId: number | null,
  posterUrl: string | null,
  seasonCount: number | null,
): Promise<number | null> {
  try {
    const [row] = await db
      .insert(contents)
      .values({
        type,
        title: title.slice(0, 512),
        year,
        tmdb_id: tmdbId,
        mal_id: malId,
        poster_url: posterUrl,
        season: seasonCount, // stores number_of_seasons for series
        enriched_at: null, // will be enriched by the pipeline enrichment pass
      })
      .onConflictDoNothing()
      .returning({ id: contents.id })
    return row?.id ?? null
  } catch (err) {
    console.warn(`[discover] insert failed for "${title}":`, (err as Error).message)
    return null
  }
}

async function getSeasonCount(tmdbId: number): Promise<number | null> {
  try {
    const tv = await getTV(tmdbId)
    return tv?.number_of_seasons ?? null
  } catch {
    return null
  }
}

// ─── discover movies ────────────────────────────────────────────────

async function discoverMovies(): Promise<
  { title: string; year: number; tmdb_id: number; poster_url: string | null }[]
> {
  console.log('[discover] Fetching movies from TMDB...')

  const [nowPlaying, popular, trending] = await Promise.all([
    getNowPlayingMovies(2),
    getPopularMovies(2),
    getTrendingMovies(1),
  ])

  const seen = new Set<number>()
  const items: { title: string; year: number; tmdb_id: number; poster_url: string | null }[] = []

  for (const m of [...nowPlaying, ...popular, ...trending]) {
    if (seen.has(m.id)) continue
    seen.add(m.id)

    const dateStr = m.release_date
    if (dateStr && daysAgo(dateStr) > 30) continue

    const year = extractYear(dateStr)
    const title = m.title || m.original_title || ''
    if (!title) continue

    items.push({
      title,
      year: year ?? new Date().getFullYear(),
      tmdb_id: m.id,
      poster_url: tmdbImage(m.poster_path),
    })
  }

  console.log(`[discover] ${items.length} movies after dedup + 30d filter`)
  return items
}

// ─── discover series ────────────────────────────────────────────────

async function discoverSeries(): Promise<
  { title: string; year: number; tmdb_id: number; poster_url: string | null; season_count: number | null }[]
> {
  console.log('[discover] Fetching TV series from TMDB...')

  const [popular, trending, onAir] = await Promise.all([
    getPopularTV(2),
    getTrendingTV(1),
    getOnTheAirTV(2),
  ])

  const seen = new Set<number>()
  const items: {
    title: string
    year: number
    tmdb_id: number
    poster_url: string | null
    season_count: number | null
  }[] = []

  for (const s of [...popular, ...trending, ...onAir]) {
    if (seen.has(s.id)) continue
    seen.add(s.id)

    const dateStr = s.first_air_date
    if (dateStr && daysAgo(dateStr) > 90) continue // series window is wider

    const year = extractYear(dateStr)
    const title = s.name || s.original_name || ''
    if (!title) continue

    items.push({
      title,
      year: year ?? new Date().getFullYear(),
      tmdb_id: s.id,
      poster_url: tmdbImage(s.poster_path),
      season_count: null, // filled per-item in processItems
    })
  }

  console.log(`[discover] ${items.length} series after dedup + 90d filter`)
  return items
}

// ─── discover anime ─────────────────────────────────────────────────

async function discoverAnimeItems(): Promise<
  { title: string; year: number; mal_id: number; poster_url: string | null; tmdb_id: number | null }[]
> {
  console.log('[discover] Fetching anime from Jikan + TMDB...')

  const [seasonNow, topAiring, tmdbAnime] = await Promise.all([
    getSeasonNow(),
    getTopAiring(30),
    discoverAnime(1).catch(() => [] as any[]),
  ])

  const seen = new Set<number>()
  const items: {
    title: string
    year: number
    mal_id: number
    poster_url: string | null
    tmdb_id: number | null
  }[] = []

  // Jikan results
  for (const a of [...seasonNow, ...topAiring]) {
    if (seen.has(a.mal_id)) continue
    seen.add(a.mal_id)

    const title = a.title_english || a.title || ''
    if (!title) continue

    const year = a.year ?? a.aired?.prop?.from?.year ?? new Date().getFullYear()

    items.push({
      title,
      year,
      mal_id: a.mal_id,
      poster_url: a.images?.jpg?.large_image_url ?? a.images?.jpg?.image_url ?? null,
      tmdb_id: null,
    })
  }

  // TMDB anime (as fallback reference)
  for (const a of tmdbAnime as any[]) {
    const aid = a.id
    if (!aid || seen.has(aid)) continue
    seen.add(aid)

    const title = a.name || a.original_name || ''
    if (!title) continue

    const year = extractYear(a.first_air_date) ?? new Date().getFullYear()

    items.push({
      title,
      year,
      mal_id: 0, // placeholder — TMDB doesn't give mal_id
      poster_url: tmdbImage(a.poster_path),
      tmdb_id: aid,
    })
  }

  console.log(`[discover] ${items.length} anime items`)
  return items
}

// ─── process items ──────────────────────────────────────────────────

async function processDiscoveredItems(
  items: {
    title: string
    year: number
    type: string
    tmdb_id: number | null
    mal_id: number | null
    poster_url: string | null
  }[],
  category: Category,
  getSeasons: boolean,
) {
  let inserted = 0
  let torrentsCollected = 0

  for (const item of items) {
    const exists = await contentExists(item.type, item.title, item.year, item.tmdb_id, item.mal_id)
    if (exists) continue

    let seasonCount: number | null = null
    if (getSeasons && item.tmdb_id) {
      seasonCount = await getSeasonCount(item.tmdb_id)
    }

    const id = await insertContent(
      item.type,
      item.title,
      item.year,
      item.tmdb_id,
      item.mal_id,
      item.poster_url,
      seasonCount,
    )

    if (id) {
      inserted++
      console.log(`[discover] + ${item.type}: ${item.title} (${item.year})`)

      // Trigger torrent collection by title
      try {
        const n = await collectTorrentsByQuery(item.title, category)
        torrentsCollected += n
        if (n > 0) console.log(`[discover]   torrents: +${n}`)
      } catch (err) {
        console.warn(`[discover] torrent collect failed for "${item.title}":`, (err as Error).message)
      }

      // Rate-limit between items
      await new Promise((r) => setTimeout(r, 1500))
    }
  }

  return { inserted, torrentsCollected }
}

// ─── main ───────────────────────────────────────────────────────────

export async function runDiscovery(): Promise<{
  movies: number
  series: number
  anime: number
  torrents: number
}> {
  console.log('=== Discovery job start ===')

  let totalTorrents = 0
  let totalMovies = 0
  let totalSeries = 0
  let totalAnime = 0

  // Movies
  try {
    const movies = await discoverMovies()
    const mapped = movies.map((m) => ({ ...m, type: 'movie', mal_id: null }))
    const r = await processDiscoveredItems(mapped, 'movies', false)
    totalMovies = r.inserted
    totalTorrents += r.torrentsCollected
  } catch (err) {
    console.error('[discover] movies failed:', err)
  }

  // Series
  try {
    const series = await discoverSeries()
    const mapped = series.map((s) => ({ ...s, type: 'series', mal_id: null }))
    const r = await processDiscoveredItems(mapped, 'series', true)
    totalSeries = r.inserted
    totalTorrents += r.torrentsCollected
  } catch (err) {
    console.error('[discover] series failed:', err)
  }

  // Anime
  try {
    const anime = await discoverAnimeItems()
    const mapped = anime.map((a) => ({ ...a, type: 'anime' }))
    const r = await processDiscoveredItems(mapped, 'anime', false)
    totalAnime = r.inserted
    totalTorrents += r.torrentsCollected
  } catch (err) {
    console.error('[discover] anime failed:', err)
  }

  console.log(
    `=== Discovery done: +${totalMovies} movies, +${totalSeries} series, +${totalAnime} anime, ${totalTorrents} torrents ===`,
  )

  return { movies: totalMovies, series: totalSeries, anime: totalAnime, torrents: totalTorrents }
}

// Run directly
if (import.meta.main) {
  await runDiscovery()
  process.exit(0)
}
