import { and, eq, isNotNull, desc, inArray } from 'drizzle-orm'
import { db } from '../../db'
import { contents, torrents, content_torrents } from '../../types'
import { parseRelease } from '../../lib/parse'
import type { RawTorrent } from '../../lib/parse'
import { detectGaps } from './gap-detector'
import type { SeasonGap } from './gap-detector'
import { fetchEztvByImdb } from './sources/eztv'
import { searchSolidTorrents } from './sources/solidtorrents'

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
  // 1. Query contents with tmdb_id IS NOT NULL AND type = 'series',
  //    ordered by id descending (most recently added first).
  const seriesRows = await db
    .select({
      id: contents.id,
      title: contents.title,
      imdb_id: contents.imdb_id,
    })
    .from(contents)
    .where(
      and(isNotNull(contents.tmdb_id), eq(contents.type, 'series')),
    )
    .orderBy(desc(contents.id))
    .limit(limit)

  const results: FillResult[] = []

  for (const series of seriesRows) {
    const contentId = series.id
    const seriesTitle = series.title

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
      `[fillGaps] "${seriesTitle}": ${totalMissing} missing episode(s) across ${gaps.length} season(s)`,
    )

    // 2c. Get imdb_id (required for EZTV)
    if (!series.imdb_id) {
      console.warn(`[fillGaps] "${seriesTitle}": no imdb_id, skipping`)
      continue
    }

    // 2d. Fetch all EZTV torrents once (cached per series)
    const cleanImdb = stripImdbPrefix(series.imdb_id)
    let eztvTorrents: RawTorrent[] = []
    let eztvHasResults = false
    try {
      eztvTorrents = await fetchEztvByImdb(cleanImdb)
      eztvHasResults = eztvTorrents.length > 0
    } catch (err) {
      console.warn(
        `[fillGaps] EZTV fetch failed for "${seriesTitle}" (imdb=${cleanImdb}):`,
        (err as Error).message,
      )
      // Continue with empty EZTV results — SolidTorrents fallback will try
    }
    console.log(
      `[fillGaps] "${seriesTitle}": fetched ${eztvTorrents.length} EZTV torrents`,
    )

    // Collect matched torrents across all gaps for this series
    const matched: MatchedTorrent[] = []

    for (const gap of gaps) {
      for (const episodeNum of gap.episodes) {
        const seasonStr = padTwo(gap.season)
        const episodeStr = padTwo(episodeNum)

        // Try EZTV first for discovery (seeds are unreliable, but hashes are valid)
        const eztvMatches = eztvTorrents
          .filter(
            (t) =>
              t.season === gap.season &&
              t.episode === episodeNum,
          )
          .sort((a, b) => (b.seeds ?? 0) - (a.seeds ?? 0))

        // Always try SolidTorrents too — it reports real seed counts for its own hashes
        let solidBest: RawTorrent | null = null
        const query = `${seriesTitle} S${seasonStr}E${episodeStr}`
        try {
          const solidResults = await searchSolidTorrents(query, 50)
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

        // Prefer SolidTorrents when it has real seeds (>0)
        let hasSolid = false
        if (solidBest && (solidBest.seeds ?? 0) > 0) {
          matched.push({
            torrent: solidBest,
            season: gap.season,
            episode: episodeNum,
          })
          hasSolid = true
        }

        // Also include ALL EZTV releases for quality variety (marked as fallback)
        for (const eztvMatch of eztvMatches) {
          if (hasSolid && eztvMatch.hash === solidBest?.hash) continue // skip duplicate
          matched.push({
            torrent: { ...eztvMatch, seeds: 0, leechers: 0 },
            season: gap.season,
            episode: episodeNum,
            isFallback: true,
          })
        }

        // If no SolidTorrents and no EZTV, we still have nothing for this episode
        if (!hasSolid && eztvMatches.length === 0) {
          // Episode still missing — nothing to add
        }

        // 2s delay between SolidTorrents API calls
        await new Promise((r) => setTimeout(r, 2_000))
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
            episode,
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
