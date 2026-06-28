import { and, eq, isNotNull, desc, inArray } from 'drizzle-orm'
import { db } from '../../db'
import { contents, torrents, content_torrents } from '../../types'
import { parseRelease } from '../../lib/parse'
import type { RawTorrent } from '../../lib/parse'
import { detectGaps } from './gap-detector'
import type { SeasonGap } from './gap-detector'
import { fetchEztvByImdb } from './sources/eztv'
import { searchSolidTorrents } from './sources/solidtorrents'
import { searchNyaa } from './sources/nyaa'

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
  // 1. Query contents with tmdb_id IS NOT NULL AND (type = 'series' OR type = 'anime'),
  //    ordered by id descending (most recently added first).
  const seriesRows = await db
    .select({
      id: contents.id,
      title: contents.title,
      imdb_id: contents.imdb_id,
      type: contents.type,
    })
    .from(contents)
    .where(
      and(
        isNotNull(contents.tmdb_id),
        // Accept both series and anime types
        // We use SQL "in" but drizzle-orm eq is cleaner
        // Use raw conditions
      ),
    )
    .orderBy(desc(contents.id))
    .limit(limit)

  // Filter to only series + anime
  const applicable = seriesRows.filter(
    (r) => r.type === 'series' || r.type === 'anime',
  )

  const results: FillResult[] = []

  for (const series of applicable) {
    const contentId = series.id
    const seriesTitle = series.title
    const isAnime = series.type === 'anime'

    // 2a. Detect missing seasons/episodes
    let gaps: SeasonGap[]
    try {
      gaps = await detectGaps(contentId)
    } catch (err) {
      console.warn(
        `[fillGaps] detectGaps failed for "${seriesTitle}" (id=${contentId}):`,
        (err as Error).message,
      )
      continue
    }

    if (gaps.length === 0) {
      console.log(`[fillGaps] "${seriesTitle}": no gaps, skipping`)
      continue
    }

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
