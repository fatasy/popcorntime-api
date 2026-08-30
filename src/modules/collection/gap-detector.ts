import { and, eq, gt } from 'drizzle-orm'
import { db } from '../../db'
import { contents, content_torrents, metadata_cache } from '../../types'
import { getAnime, getAnimeAiredEpisodeCount } from '../enrichment/myanimelist'

const BASE = 'https://api.themoviedb.org/3'
const TVMAZE_BASE = 'https://api.tvmaze.com'
const TMDB_DELAY = 300 // ms between TMDB requests
const CACHE_TTL_HOURS = 24

// ─── Exported types ────────────────────────────────────────────────────────

export interface SeasonGap {
  season: number
  episodes: number[] // episode numbers that are missing
}

export interface GapResult {
  gaps: SeasonGap[]
  isAiring: boolean
}

interface TmdbSeasonData {
  seasons: { season_number: number; episode_count: number }[]
}

interface TmdbEpisodeData {
  episodes: { episode_number: number; name: string }[]
}

// ─── TMDB fetch ────────────────────────────────────────────────────────────

async function tmdbFetch<T = unknown>(path: string): Promise<T> {
  const url = new URL(BASE + path)
  url.searchParams.set('api_key', process.env.TMDB_API_KEY!)
  url.searchParams.set('language', 'pt-BR')
  const res = await fetch(url, { signal: AbortSignal.timeout(15_000) })
  if (!res.ok) {
    throw new Error(`TMDB ${res.status} on ${path}`)
  }
  return (await res.json()) as T
}

// ─── TVMaze fetch (fallback, free, no API key) ──────────────────────────────

interface TVMazeEpisode {
  season: number
  number: number
  name: string
}

async function tvmazeGetSeasons(title: string, imdbId: string | null): Promise<TmdbSeasonData> {
  // Try IMDB lookup first
  let showId: number | null = null

  if (imdbId) {
    const res = await fetch(`${TVMAZE_BASE}/lookup/shows?imdb=${imdbId}`, {
      signal: AbortSignal.timeout(10_000),
    })
    if (res.ok) {
      const json = await res.json() as { id?: number } | null
      if (json?.id) showId = json.id
    }
  }

  // Fallback: search by name
  if (!showId) {
    const query = encodeURIComponent(title)
    const res = await fetch(`${TVMAZE_BASE}/search/shows?q=${query}`, {
      signal: AbortSignal.timeout(10_000),
    })
    if (res.ok) {
      const results = (await res.json()) as { show: { id: number; name: string; premiered?: string } }[]
      // Pick first match by year similarity (simple heuristic)
      const match = results[0]
      if (match?.show?.id) showId = match.show.id
    }
  }

  if (!showId) throw new Error('TVMaze: show not found')

  // Fetch episodes
  const res = await fetch(`${TVMAZE_BASE}/shows/${showId}/episodes`, {
    signal: AbortSignal.timeout(10_000),
  })
  if (!res.ok) throw new Error(`TVMaze ${res.status} on /shows/${showId}/episodes`)

  const episodes = (await res.json()) as TVMazeEpisode[]

  // Group by season
  const seasonMap = new Map<number, number>()
  for (const ep of episodes) {
    if (ep.season <= 0) continue // skip specials
    seasonMap.set(ep.season, Math.max(seasonMap.get(ep.season) ?? 0, ep.number))
  }

  const seasons = Array.from(seasonMap.entries()).map(([season_number, episode_count]) => ({
    season_number,
    episode_count,
  }))

  return { seasons }
}

async function tvmazeGetEpisodes(
  title: string,
  imdbId: string | null,
  seasonNum: number,
): Promise<TmdbEpisodeData> {
  // Reuse the show lookup logic (but simplified — we just need episodes for this season)
  let showId: number | null = null

  if (imdbId) {
    const res = await fetch(`${TVMAZE_BASE}/lookup/shows?imdb=${imdbId}`, {
      signal: AbortSignal.timeout(10_000),
    })
    if (res.ok) {
      const json = await res.json() as { id?: number } | null
      if (json?.id) showId = json.id
    }
  }

  if (!showId) {
    const query = encodeURIComponent(title)
    const res = await fetch(`${TVMAZE_BASE}/search/shows?q=${query}`, {
      signal: AbortSignal.timeout(10_000),
    })
    if (res.ok) {
      const results = (await res.json()) as { show: { id: number } }[]
      if (results[0]?.show?.id) showId = results[0].show.id
    }
  }

  if (!showId) throw new Error('TVMaze: show not found for episodes')

  const res = await fetch(`${TVMAZE_BASE}/shows/${showId}/episodes`, {
    signal: AbortSignal.timeout(10_000),
  })
  if (!res.ok) throw new Error(`TVMaze ${res.status} on /shows/${showId}/episodes`)

  const allEpisodes = (await res.json()) as TVMazeEpisode[]
  const episodes = allEpisodes
    .filter((ep) => ep.season === seasonNum)
    .map((ep) => ({ episode_number: ep.number, name: ep.name }))

  return { episodes }
}

// ─── Cache helpers ─────────────────────────────────────────────────────────

async function cacheGet(source: string, key: string): Promise<unknown | null> {
  const cutoff = new Date(Date.now() - CACHE_TTL_HOURS * 60 * 60 * 1000)
  const rows = await db
    .select({ response: metadata_cache.response })
    .from(metadata_cache)
    .where(
      and(
        eq(metadata_cache.source, source),
        eq(metadata_cache.lookup_key, key),
        gt(metadata_cache.cached_at, cutoff),
      ),
    )
    .limit(1)
  return (rows[0]?.response as unknown) ?? null
}

async function cacheSet(source: string, key: string, data: unknown): Promise<void> {
  await db
    .insert(metadata_cache)
    .values({ source, lookup_key: key, response: data as Record<string, unknown> })
    .onConflictDoUpdate({
      target: [metadata_cache.source, metadata_cache.lookup_key],
      set: { response: data as Record<string, unknown>, cached_at: new Date() },
    })
}

// ─── Gap detection ─────────────────────────────────────────────────────────

const JIKAN_DELAY_MS = 400

/**
 * Gap detection for anime keyed by MAL id (Jikan) rather than TMDB.
 * MAL-only anime (the vast majority) can't use the TMDB path below.
 * A single airing season is assumed; the dominant existing season is reused
 * for newly inserted episodes so the season semantics stay consistent.
 */
async function detectAnimeGaps(content: {
  id: number
  mal_id: number | null
  title: string | null
}): Promise<GapResult> {
  const malId = content.mal_id
  // content.id should be non-null here; mal_id guarded by the caller
  const key = `anime:${malId}`
  let info = (await cacheGet('jikan', key)) as {
    status?: string | null
    episodes?: number | null
    latestAired?: number | null
  } | null

  if (!info) {
    const anime = await getAnime(malId!)
    await new Promise((r) => setTimeout(r, JIKAN_DELAY_MS))
    const latestAired = await getAnimeAiredEpisodeCount(malId!)
    info = {
      status: anime?.status ?? null,
      episodes: anime?.episodes ?? null,
      latestAired,
    }
    // Only cache a usable Jikan response. When MAL/Jikan is down it often
    // returns null status + null episodes; caching that poisons the 24h TTL and
    // leaves the anime permanently "no gaps". Leave it uncached so the next run
    // re-fetches from Jikan instead of trusting a null-filled entry.
    if (info.status || info.episodes || info.latestAired) {
      await cacheSet('jikan', key, info)
      await new Promise((r) => setTimeout(r, JIKAN_DELAY_MS))
    }
  }

  const isAiring =
    info.status === 'Currently Airing' || info.status === 'Currently Publishing'
  // While airing, MAL `episodes` is usually null -> fall back to latestAired.
  let episodeCount = info.episodes ?? info.latestAired ?? 0

  // New-season anime frequently have an EMPTY episode list on MAL/Jikan while
  // airing, and MAL/Jikan can also return a null-filled response when it's down
  // — in both cases episodeCount resolves to 0 and we would wrongly report
  // "no gaps", leaving the anime permanently unfilled (seen with Black Torch,
  // Yani Neko, Jaadugar, Marriagetoxin in Aug 2026). When we have no Jikan
  // episode count at all and the content actually exists in the catalog,
  // derive the expected episode count from the torrent source (nyaa) so
  // fillGaps targets the right episodes.
  if (episodeCount <= 0 && content.title) {
    try {
      const { searchNyaa } = await import('../collection/sources/nyaa')
      const { parseRelease } = await import('../../lib/parse')
      const results = await searchNyaa(content.title, 50)
      await new Promise((r) => setTimeout(r, JIKAN_DELAY_MS))
      let maxEp = 0
      for (const t of results) {
        const p = parseRelease(t.title)
        if (p.episode && Number(p.episode) > maxEp) maxEp = Number(p.episode)
      }
      if (maxEp > 0) {
        console.log(
          `[detectAnimeGaps] "${content.title}": Jikan episode list empty, derived latest aired = ep ${maxEp} from nyaa`,
        )
        episodeCount = maxEp
      }
    } catch (err) {
      console.warn(
        `[detectAnimeGaps] failed to derive aired count from nyaa for "${content.title}":`,
        (err as Error).message,
      )
    }
  }

  if (episodeCount <= 0) return { gaps: [], isAiring }

  // Existing episodes for this content, across ALL seasons (anime season values
  // are messy in the DB: NULL/1/2/...). Avoids falsely flagging eps that exist
  // under a different season label.
  const existingRows = await db
    .select({ episode: content_torrents.episode })
    .from(content_torrents)
    .where(eq(content_torrents.content_id, content.id))
  const existing = new Set(
    existingRows.filter((r): r is { episode: number } => r.episode != null).map((r) => r.episode),
  )

  // Dominant existing season (default 1) — new eps go under it.
  const seasonRows = await db
    .select({ season: content_torrents.season })
    .from(content_torrents)
    .where(eq(content_torrents.content_id, content.id))
  const counts = new Map<number, number>()
  for (const s of seasonRows) {
    if (s.season != null && s.season > 0) {
      counts.set(s.season, (counts.get(s.season) ?? 0) + 1)
    }
  }
  let season = 1
  let best = 0
  for (const [k, c] of counts) {
    if (c > best) {
      best = c
      season = k
    }
  }

  const expected = Array.from({ length: episodeCount }, (_, i) => i + 1)
  const missing = expected.filter((ep) => !existing.has(ep))

  return {
    gaps: missing.length > 0 ? [{ season, episodes: missing }] : [],
    isAiring,
  }
}

/**
 * Detect which seasons/episodes are MISSING for a TV series.
 *
 * Compares TMDB (primary) or TVMaze (fallback) season/episode metadata
 * against what we already have in the database. Uses metadata_cache with
 * 24h TTL to avoid excessive API calls.
 */
export async function detectGaps(contentId: number): Promise<GapResult> {
  // 1. Look up content by ID
  const [content] = await db
    .select({
      id: contents.id,
      tmdb_id: contents.tmdb_id,
      type: contents.type,
      title: contents.title,
      imdb_id: contents.imdb_id,
      mal_id: contents.mal_id,
    })
    .from(contents)
    .where(eq(contents.id, contentId))
    .limit(1)

  if (!content) throw new Error(`Content ${contentId} not found`)
  if (content.type !== 'series' && content.type !== 'anime') throw new Error(`Content ${contentId} is not a series or anime`)
  if (content.tmdb_id == null) {
    // MAL-keyed anime have no TMDB id -> use the Jikan path.
    if (content.type === 'anime' && content.mal_id != null) {
      return detectAnimeGaps(content)
    }
    throw new Error(`Content ${contentId} has no tmdb_id or mal_id`)
  }

  const tmdbId = content.tmdb_id
  const title = content.title ?? ''
  const imdbId = content.imdb_id ?? null
  let isAiring = false

  // 2. Get season list (try TMDB cache → TMDB API → TVMaze cache → TVMaze API)
  const seasonCacheKey = `seasons:${tmdbId}`
  let seasonData = (await cacheGet('tmdb', seasonCacheKey)) as TmdbSeasonData | null

  if (!seasonData) {
    try {
      const tv = await tmdbFetch<{ 
        seasons?: { season_number: number; episode_count: number; name: string }[]
        status?: string
      }>(
        `/tv/${tmdbId}`,
      )
      await new Promise((r) => setTimeout(r, TMDB_DELAY))
      const seasons = (tv.seasons ?? [])
        .filter((s) => s.season_number > 0 && s.episode_count > 0)
        .map((s) => ({ season_number: s.season_number, episode_count: s.episode_count }))
      seasonData = { seasons }
      await cacheSet('tmdb', seasonCacheKey, seasonData)
      isAiring = tv.status === 'Returning Series' || tv.status === 'In Production'
    } catch (tmdbErr) {
      console.warn(`[detectGaps] TMDB failed for #${contentId}, trying TVMaze: ${(tmdbErr as Error).message}`)
      // Try TVMaze
      seasonData = (await cacheGet('tvmaze', seasonCacheKey)) as TmdbSeasonData | null
      if (!seasonData) {
        seasonData = await tvmazeGetSeasons(title, imdbId)
        await cacheSet('tvmaze', seasonCacheKey, seasonData)
      }
    }
  }

  const gaps: SeasonGap[] = []

  // 3. For each season, fetch episode list and compare against DB
  for (const s of seasonData.seasons) {
    const seasonNum = s.season_number
    const episodeCount = s.episode_count

    // a. Get episode list (try TMDB cache → TMDB → TVMaze cache → TVMaze)
    const epCacheKey = `episodes:${tmdbId}:${seasonNum}`
    let episodeData = (await cacheGet('tmdb', epCacheKey)) as TmdbEpisodeData | null

    if (!episodeData) {
      try {
        const seasonResp = await tmdbFetch<{
          episodes?: { episode_number: number; name: string; season_number: number }[]
        }>(`/tv/${tmdbId}/season/${seasonNum}`)
        await new Promise((r) => setTimeout(r, TMDB_DELAY))
        const episodes = (seasonResp.episodes ?? []).map((ep) => ({
          episode_number: ep.episode_number,
          name: ep.name,
        }))
        episodeData = { episodes }
        await cacheSet('tmdb', epCacheKey, episodeData)
      } catch (tmdbErr) {
        console.warn(`[detectGaps] TMDB S${seasonNum} failed, trying TVMaze: ${(tmdbErr as Error).message}`)
        episodeData = (await cacheGet('tvmaze', epCacheKey)) as TmdbEpisodeData | null
        if (!episodeData) {
          episodeData = await tvmazeGetEpisodes(title, imdbId, seasonNum)
          await cacheSet('tvmaze', epCacheKey, episodeData)
        }
      }
    }

    // b. Query content_torrents for existing episodes for this season
    const existingRows = await db
      .select({ episode: content_torrents.episode })
      .from(content_torrents)
      .where(
        and(eq(content_torrents.content_id, contentId), eq(content_torrents.season, seasonNum)),
      )

    const existingEpisodes = new Set(
      existingRows.filter((r): r is { episode: number } => r.episode != null).map((r) => r.episode),
    )

    // c. Compare: expected episode numbers vs what we have
    const expectedEpisodes: number[] = Array.from({ length: episodeCount }, (_, i) => i + 1)
    const missing = expectedEpisodes.filter((ep) => !existingEpisodes.has(ep))

    if (missing.length > 0) {
      gaps.push({ season: seasonNum, episodes: missing })
    }
  }

  return { gaps, isAiring }
}
