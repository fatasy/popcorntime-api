import { and, eq, isNotNull, desc, inArray, or } from 'drizzle-orm'
import { db } from '../../db'
import { contents, torrents, content_torrents } from '../../types'
import { parseRelease } from '../../lib/parse'
import type { RawTorrent } from '../../lib/parse'
import { detectGaps } from './gap-detector'
import type { SeasonGap, GapResult } from './gap-detector'
import { fetchEztvByImdb } from './sources/eztv'
import { searchSolidTorrents } from './sources/solidtorrents'
import { searchNyaa } from './sources/nyaa'
import { getSeasonNow } from '../enrichment/myanimelist'

// ─── Types ──────────────────────────────────────────────────────────────────

interface FillResult {
  seriesId: number
  title: string
  torrentsAdded: number
}

interface MatchedTorrent {
  torrent: RawTorrent
  season: number
  episode: number
  isFallback?: boolean // true if EZTV fallback (seeds unreliable)
}

// ─── Pack detection ─────────────────────────────────────────────────────────

const PACK_PATTERNS = [
  /\bSeason\b/i,
  /\bComplete\b/i,
  /S\d{2}E\d{2}-/i,
]

function isPack(title: string): boolean {
  return PACK_PATTERNS.some((re) => re.test(title))
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function padTwo(n: number): string {
  return String(n).padStart(2, '0')
}

// Max missing episodes to search per candidate, per pipeline run. Keeps a huge
// backfill (or a completely-unfilled seasonal anime) from monopolizing the run
// with hundreds of nyaa/SolidTorrents calls. Each run advances by this much.
const MAX_GAP_EPISODES_PER_RUN = 8

function stripImdbPrefix(imdbId: string): string {
  return imdbId.replace(/^tt/i, '')
}

// ─── Gap filler ─────────────────────────────────────────────────────────────

/**
 * Fill missing episodes for TV series by fetching torrents from EZTV
 * (primary) and SolidTorrents (fallback).
 *
 * @param limit Maximum number of series to process (default 5).
 * @returns Summary array with torrentsAdded counts per series.
 */
export async function fillGaps(limit = 5): Promise<FillResult[]> {
  const evalLimit = limit * 4

  // Priority candidates: currently-airing anime (Jikan season_now) matched by
  // mal_id. These are the ones dropping a weekly episode that the user actually
  // cares about. Ordering the general window by id DESC never reaches them,
  // because airing anime carry LOW content ids (created before months of junk).
  let priority: Array<{ id: number; title: string; imdb_id: string | null; type: string; mal_id: number | null }> = []
  try {
    const airingNow = await getSeasonNow()
    const airingMal = Array.from(new Set(airingNow.map((a) => a.mal_id)))
    if (airingMal.length > 0) {
      priority = await db
        .select({
          id: contents.id,
          title: contents.title,
          imdb_id: contents.imdb_id,
          type: contents.type,
          mal_id: contents.mal_id,
        })
        .from(contents)
        .where(
          and(
            eq(contents.type, 'anime'),
            isNotNull(contents.enriched_at),
            inArray(contents.mal_id, airingMal),
          ),
        )
      console.log(`[fillGaps] ${priority.length} currently-airing anime candidates`)
    }
  } catch (err) {
    console.warn('[fillGaps] failed to fetch airing anime:', (err as Error).message)
  }

  // General window: series that can be filled (tmdb for detect + imdb for EZTV)
  // and real enriched anime (mal for Jikan detect + nyaa fill). Excludes the
  // unmatchable apibay junk piles that can't be filled anyway.
  const general = await db
    .select({
      id: contents.id,
      title: contents.title,
      imdb_id: contents.imdb_id,
      type: contents.type,
      mal_id: contents.mal_id,
    })
    .from(contents)
    .where(
      and(
        inArray(contents.type, ['series', 'anime']),
        or(
          and(eq(contents.type, 'series'), isNotNull(contents.tmdb_id), isNotNull(contents.imdb_id)),
          and(eq(contents.type, 'anime'), isNotNull(contents.mal_id), isNotNull(contents.enriched_at)),
        ),
      ),
    )
    .orderBy(desc(contents.id))
    .limit(evalLimit)

  // Combine: airing anime first, then the general window (dedup by id).
  const seen = new Set<number>()
  const seriesRows = [...priority, ...general].filter((r) => {
    if (seen.has(r.id)) return false
    seen.add(r.id)
    return true
  })

  // Filter to only series + anime
  const applicable = seriesRows.filter(
    (r) => r.type === 'series' || r.type === 'anime',
  )

  // 2. For each candidate, detect gaps + airing status
  interface Candidate {
    series: typeof applicable[0]
    gaps: SeasonGap[]
    isAiring: boolean
    totalMissing: number
  }
  const candidates: Candidate[] = []

  for (const series of applicable) {
    const contentId = series.id
    const seriesTitle = series.title

    let result: GapResult
    try {
      result = await detectGaps(contentId)
    } catch (err) {
      console.warn(
        `[fillGaps] detectGaps failed for "${seriesTitle}" (id=${contentId}):`,
        (err as Error).message,
      )
      continue
    }

    if (result.gaps.length === 0) {
      console.log(`[fillGaps] "${seriesTitle}": no gaps, skipping`)
      continue
    }

    const totalMissing = result.gaps.reduce((sum, g) => sum + g.episodes.length, 0)
    candidates.push({
      series,
      gaps: result.gaps,
      isAiring: result.isAiring,
      totalMissing,
    })
  }

  // 3. Sort: currently-airing first, then anime before series (weekly anime is
  //    the priority), then by FEWEST missing episodes — so a huge backfill like
  //    "Survivor" (162 missing) does not jump the queue and block the anime that
  //    only need their latest weekly episode.
  candidates.sort((a, b) => {
    if (a.isAiring !== b.isAiring) return a.isAiring ? -1 : 1
    const aAnime = a.series.type === 'anime' ? 0 : 1
    const bAnime = b.series.type === 'anime' ? 0 : 1
    if (aAnime !== bAnime) return aAnime - bAnime
    return a.totalMissing - b.totalMissing
  })

  // 4. Take top N and process
  const toProcess = candidates.slice(0, limit)
  const results: FillResult[] = []

  for (const candidate of toProcess) {
    const { series, isAiring } = candidate
    const contentId = series.id
    const seriesTitle = series.title
    const isAnime = series.type === 'anime'

    // Cap episodes processed per candidate, per run (see constant above).
    const caps: SeasonGap[] = []
    let budget = MAX_GAP_EPISODES_PER_RUN
    for (const g of candidate.gaps) {
      if (budget <= 0) break
      const slice = g.episodes.slice(0, budget)
      budget -= slice.length
      caps.push({ season: g.season, episodes: slice })
    }
    const gaps = caps

    const totalMissing = gaps.reduce((sum, g) => sum + g.episodes.length, 0)
    console.log(
      `[fillGaps] "${seriesTitle}" (${series.type}): ${totalMissing} missing episode(s) across ${gaps.length} season(s)`,
    )

    // Collect matched torrents across all gaps for this series
    const matched: MatchedTorrent[] = []

    if (isAnime) {
      // ─── Anime path: use nyaa.si ─────────────────────────────────────
      const nyaaCache = new Map<string, RawTorrent[]>()

      for (const gap of gaps) {
        for (const episodeNum of gap.episodes) {
          const seasonStr = padTwo(gap.season)
          const episodeStr = padTwo(episodeNum)

          // Search nyaa.si for this specific season+episode
          const query = `${seriesTitle} ${episodeStr}`
          let nyaaResults: RawTorrent[]
          const cacheKey = query

          if (nyaaCache.has(cacheKey)) {
            nyaaResults = nyaaCache.get(cacheKey)!
          } else {
            try {
              nyaaResults = await searchNyaa(query, 50)
              nyaaCache.set(cacheKey, nyaaResults)
            } catch (err) {
              console.warn(
                `[fillGaps] nyaa search failed for "${query}":`,
                (err as Error).message,
              )
              nyaaResults = []
            }
          }

          // Match results by parsing S/E from titles
          const nyaaMatches = nyaaResults
            .filter((t) => {
              if ((t.seeds ?? 0) < 1) return false
              const parsed = parseRelease(t.title)
              // For anime, episode matching via "Title - 01" pattern
              if (parsed.episode === episodeNum) return true
              // Also check S/E patterns
              if (parsed.season === gap.season && parsed.episode === episodeNum)
                return true
              return false
            })
            .sort((a, b) => (b.seeds ?? 0) - (a.seeds ?? 0))

          for (const m of nyaaMatches.slice(0, 5)) {
            matched.push({
              torrent: m,
              season: gap.season,
              episode: episodeNum,
            })
          }
        }

        // Also search for season packs on nyaa
        const packQuery = `${seriesTitle} S${padTwo(gap.season)}`
        try {
          const packResults = await searchNyaa(packQuery, 30)
          const viablePacks = packResults.filter((t) => {
            if (!isPack(t.title)) return false
            if ((t.seeds ?? 0) < 1) return false
            return true
          })
          for (const pack of viablePacks) {
            matched.push({
              torrent: pack,
              season: gap.season,
              episode: -1, // season pack
            })
          }
          if (viablePacks.length > 0) {
            console.log(
              `[fillGaps] "${seriesTitle}": found ${viablePacks.length} nyaa season pack(s)`,
            )
          }
        } catch (err) {
          console.warn(`[fillGaps] nyaa pack search failed:`, (err as Error).message)
        }
      }
    } else {
      // ─── Series path: EZTV + SolidTorrents (unchanged) ──────────────
      // SolidTorrents cache for this series to avoid duplicate API calls
      const solidCache = new Map<string, RawTorrent[]>()

      // 2c. Get imdb_id (required for EZTV)
      if (!series.imdb_id) {
        console.warn(`[fillGaps] "${seriesTitle}": no imdb_id, skipping`)
        continue
      }

      // 2d. Fetch all EZTV torrents once (cached per series)
      const cleanImdb = stripImdbPrefix(series.imdb_id)
      let eztvTorrents: RawTorrent[] = []
      try {
        eztvTorrents = await fetchEztvByImdb(cleanImdb)
      } catch (err) {
        console.warn(
          `[fillGaps] EZTV fetch failed for "${seriesTitle}" (imdb=${cleanImdb}):`,
          (err as Error).message,
        )
      }
      console.log(
        `[fillGaps] "${seriesTitle}": fetched ${eztvTorrents.length} EZTV torrents`,
      )

      for (const gap of gaps) {
        for (const episodeNum of gap.episodes) {
          const seasonStr = padTwo(gap.season)
          const episodeStr = padTwo(episodeNum)

          const eztvMatches = eztvTorrents
            .filter(
              (t) =>
                t.season === gap.season &&
                t.episode === episodeNum,
            )
            .sort((a, b) => (b.seeds ?? 0) - (a.seeds ?? 0))

          let solidBest: RawTorrent | null = null
          const query = `${seriesTitle} S${seasonStr}E${episodeStr}`
          try {
            const solidResults = await searchSolidTorrents(query, 50)
            solidCache.set(query, solidResults)
            const solidMatches = solidResults
              .filter((t) => {
                if (isPack(t.title)) return false
                if ((t.seeds ?? 0) < 1) return false
                const parsed = parseRelease(t.title)
                if (parsed.season !== gap.season) return false
                if (parsed.episode !== episodeNum) return false
                return true
              })
              .sort((a, b) => (b.seeds ?? 0) - (a.seeds ?? 0))
            if (solidMatches.length > 0) {
              solidBest = solidMatches[0]!
            }
          } catch (err) {
            console.warn(
              `[fillGaps] SolidTorrents search failed for "${query}":`,
              (err as Error).message,
            )
          }

          let hasSolid = false
          if (solidBest && (solidBest.seeds ?? 0) > 0) {
            matched.push({
              torrent: solidBest,
              season: gap.season,
              episode: episodeNum,
            })
            hasSolid = true
          }

          for (const eztvMatch of eztvMatches) {
            if (hasSolid && eztvMatch.hash === solidBest?.hash) continue
            matched.push({
              torrent: { ...eztvMatch, seeds: 0, leechers: 0 },
              season: gap.season,
              episode: episodeNum,
              isFallback: true,
            })
          }
        }

        // Season packs for series
        try {
          const packQuery = `${seriesTitle} S${padTwo(gaps[0]!.season)} 2160p`
          let packResults: RawTorrent[]
          if (solidCache.has(packQuery)) {
            packResults = solidCache.get(packQuery)!
          } else {
            const uniqueHashes = new Map<string, RawTorrent>()
            for (const cachedResults of Array.from(solidCache.values())) {
              for (const t of cachedResults) {
                if (!uniqueHashes.has(t.hash)) {
                  uniqueHashes.set(t.hash, t)
                }
              }
            }
            const cachedPacks = Array.from(uniqueHashes.values()).filter((t) => {
              if (!isPack(t.title)) return false
              if ((t.seeds ?? 0) < 1) return false
              return /2160|4k|uhd/i.test(t.title)
            })
            if (cachedPacks.length > 0) {
              console.log(
                `[fillGaps] reusing ${cachedPacks.length} cached pack(s) from per-episode searches`,
              )
              packResults = cachedPacks
            } else {
              packResults = await searchSolidTorrents(packQuery, 30)
              solidCache.set(packQuery, packResults)
            }
          }
          const viablePacks = packResults.filter((t) => {
            if (!isPack(t.title)) return false
            if ((t.seeds ?? 0) < 1) return false
            return /2160|4k|uhd/i.test(t.title)
          })
          for (const pack of viablePacks) {
            for (const gap of gaps) {
              matched.push({
                torrent: pack,
                season: gap.season,
                episode: -1,
              })
            }
          }
          if (viablePacks.length > 0) {
            console.log(`[fillGaps] "${seriesTitle}": found ${viablePacks.length} season pack(s)`)
          }
        } catch (err) {
          console.warn(`[fillGaps] Season pack search failed:`, (err as Error).message)
        }
      }
    }

    if (matched.length === 0) {
      console.log(`[fillGaps] "${seriesTitle}": no torrents matched for any gap`)
      results.push({ seriesId: contentId, title: seriesTitle, torrentsAdded: 0 })
      continue
    }

    // 2g. Batch-insert torrents (dedupe by hash within the batch)
    const byHash = new Map<string, MatchedTorrent>()
    for (const m of matched) {
      if (!byHash.has(m.torrent.hash)) {
        byHash.set(m.torrent.hash, m)
      }
    }

    const insertValues = Array.from(byHash.values()).map(({ torrent: t }) => ({
      source: t.source,
      hash: t.hash,
      title: t.title.slice(0, 512),
      magnet_link: t.magnet_link,
      seeds: t.seeds,
      leechers: t.leechers,
      size_bytes: t.size_bytes ?? null,
      uploader: t.uploader ? t.uploader.slice(0, 128) : null,
      category: t.category,
      published_at: t.published_at ?? null,
    }))

    let seriesTorrentsAdded = 0

    try {
      // Insert torrents (skip if hash already exists)
      await db.insert(torrents).values(insertValues).onConflictDoNothing()

      // Resolve all torrent IDs by hash
      const hashes = Array.from(byHash.keys())
      const existingRows = await db
        .select({ id: torrents.id, hash: torrents.hash })
        .from(torrents)
        .where(inArray(torrents.hash, hashes))

      const hashToId = new Map(existingRows.map((r) => [r.hash, r.id]))

      // 2h. Batch-link to content_torrents
      const linkValues = Array.from(byHash.values())
        .map(({ torrent, season, episode }) => {
          const torrentId = hashToId.get(torrent.hash)
          if (torrentId == null) return null
          return {
            content_id: contentId,
            torrent_id: torrentId,
            season,
            episode: episode === -1 ? null : episode,
          }
        })
        .filter((v): v is NonNullable<typeof v> => v != null)

      if (linkValues.length > 0) {
        await db
          .insert(content_torrents)
          .values(linkValues)
          .onConflictDoNothing()

        seriesTorrentsAdded = linkValues.length
      }
    } catch (err) {
      console.warn(
        `[fillGaps] batch insert/link failed for "${seriesTitle}":`,
        (err as Error).message,
      )
    }

    console.log(
      `[fillGaps] "${seriesTitle}": added ${seriesTorrentsAdded} torrent(s)`,
    )

    results.push({
      seriesId: contentId,
      title: seriesTitle,
      torrentsAdded: seriesTorrentsAdded,
    })
  }

  return results
}
