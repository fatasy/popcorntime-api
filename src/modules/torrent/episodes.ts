import { and, asc, eq, isNull } from 'drizzle-orm'
import { db } from '../../db'
import { contents, content_torrents, torrents, torrent_episodes } from '../../types'
import { getTV, getSeasonEpisodes } from '../enrichment/tmdb'
import { parseRelease } from '../../lib/parse'
import { classifySeasonCoverage, type SeasonCoverage } from './season-coverage'
import { extractQualityLabel } from './quality'

// ─── Types ────────────────────────────────────────────────────────────────

export interface EpisodeTorrent {
  hash: string
  magnet_link: string
  title: string
  seeds: number
  file_index: number | null
  inferred: boolean
  quality: string | null
  size_bytes: number | null
}

export interface EpisodeInfo {
  season: number
  episode: number
  title: string | null
  air_date: string | null
  torrents: EpisodeTorrent[]
}

interface LinkedTorrent {
  torrent_id: number
  hash: string
  magnet_link: string
  title: string
  seeds: number
  size_bytes: number | null
  season: number | null
  episode: number | null
}

// ─── Helper ─────────────────────────────────────────────────────────────

/** Create a consistent EpisodeTorrent object with quality extracted from title */
function makeEpisodeTorrent(
  t: LinkedTorrent,
  overrides: { file_index?: number | null; inferred?: boolean },
): EpisodeTorrent {
  return {
    hash: t.hash,
    magnet_link: t.magnet_link,
    title: t.title,
    seeds: t.seeds ?? 0,
    file_index: overrides.file_index ?? null,
    inferred: overrides.inferred ?? false,
    quality: extractQualityLabel(t.title),
    size_bytes: t.size_bytes ?? null,
  }
}

// ─── Main export ──────────────────────────────────────────────────────────

/**
 * Resolve structured episode data for a series content.
 *
 * Strategy A (TMDB): when the content has a `tmdb_id`, fetch TV metadata
 * from TMDB and map torrents to episodes using `content_torrents.season/episode`.
 *
 * Strategy B (heuristic fallback): when there is no `tmdb_id` or TMDB fails,
 * parse season/episode from torrent titles via regex.
 */
export async function resolveEpisodes(contentId: number): Promise<EpisodeInfo[]> {
  // 1. Load content
  const [content] = await db
    .select({ type: contents.type, tmdb_id: contents.tmdb_id, title: contents.title })
    .from(contents)
    .where(eq(contents.id, contentId))
    .limit(1)
  if (!content || content.type !== 'series') {
    throw new Error(`Content ${contentId} is not a series`)
  }

  // 2. Load all linked torrents (now including size_bytes)
  const linked = await db
    .select({
      torrent_id: content_torrents.torrent_id,
      hash: torrents.hash,
      magnet_link: torrents.magnet_link,
      title: torrents.title,
      seeds: torrents.seeds,
      size_bytes: torrents.size_bytes,
      season: content_torrents.season,
      episode: content_torrents.episode,
    })
    .from(content_torrents)
    .innerJoin(torrents, eq(torrents.id, content_torrents.torrent_id))
    .where(eq(content_torrents.content_id, contentId))

  // 3. Try TMDB strategy first
  if (content.tmdb_id) {
    try {
      return await resolveWithTmdb(contentId, content.tmdb_id, linked)
    } catch (err) {
      console.warn(
        `[episodes] TMDB resolution failed for content ${contentId} (tmdb:${content.tmdb_id}):`,
        (err as Error).message,
      )
      // Fall through to heuristic
    }
  }

  // 4. Heuristic fallback
  return resolveHeuristic(linked)
}

// ─── Strategy A: TMDB ─────────────────────────────────────────────────────

async function resolveWithTmdb(
  contentId: number,
  tmdbId: number,
  linked: LinkedTorrent[],
): Promise<EpisodeInfo[]> {
  // Fetch TV details to get season list
  const tv = await getTV(tmdbId)

  // Build a map of (season, episode) → TMDB episode data
  const tmdbEpisodes = new Map<string, { title: string | null; air_date: string | null }>()

  // Fetch each season's episode list in parallel
  const seasons = tv.seasons ?? []
  const seasonRequests = seasons
    .filter((s: any) => s.season_number > 0) // skip specials (season 0)
    .map(async (s: any) => {
      const seasonNum: number = s.season_number
      try {
        const data = await getSeasonEpisodes(tmdbId, seasonNum)
        for (const ep of data.episodes ?? []) {
          const key = `${seasonNum}|${ep.episode_number}`
          tmdbEpisodes.set(key, {
            title: ep.name ?? null,
            air_date: ep.air_date ?? null,
          })
        }
      } catch (err) {
        console.warn(
          `[episodes] TMDB season ${seasonNum} fetch failed for tmdb:${tmdbId}:`,
          (err as Error).message,
        )
      }
    })
  await Promise.all(seasonRequests)

  // Map torrents to episodes
  const episodeMap = new Map<string, EpisodeTorrent[]>()

  // First, classify each linked torrent for season coverage
  const coverageResults = new Map<number, SeasonCoverage>()
  for (const t of linked) {
    try {
      const coverage = await classifySeasonCoverage(t.title, tmdbId)
      coverageResults.set(t.torrent_id, coverage)
    } catch (err) {
      console.warn(
        `[episodes] Coverage classification failed for torrent ${t.torrent_id}:`,
        (err as Error).message,
      )
      coverageResults.set(t.torrent_id, {
        type: 'unknown',
        seasons: [],
        confidence: 'heuristic',
      })
    }
  }

  for (const t of linked) {
    const coverage = coverageResults.get(t.torrent_id)

    if (t.season == null) {
      // No season info in content_torrents — try coverage
      if (coverage && coverage.seasons.length > 0) {
        // Multi-season coverage: add to all covered seasons
        let fileOffset = 0 // cumulative file offset across seasons
        for (const s of coverage.seasons) {
          const episodesForSeason = Array.from(tmdbEpisodes.entries())
            .filter(([k]) => k.startsWith(`${s}|`))
            .map(([k, tmdb]) => {
              const epNum = parseInt(k.split('|')[1]!, 10)
              return { key: k, episode: epNum, tmdb }
            })

          if (episodesForSeason.length > 0) {
            for (const { key, episode: epNum } of episodesForSeason) {
              if (!episodeMap.has(key)) episodeMap.set(key, [])
              episodeMap.get(key)!.push(makeEpisodeTorrent(t, {
                file_index: fileOffset + (epNum - 1),
                inferred: false,
              }))
            }
            fileOffset += episodesForSeason.length
          } else {
            // No TMDB episodes for this season — add generic entry
            const key = `${s}|0`
            if (!episodeMap.has(key)) episodeMap.set(key, [])
            episodeMap.get(key)!.push(makeEpisodeTorrent(t, {
              file_index: null,
              inferred: true,
            }))
          }
        }
      } else {
        // Unknown coverage with no season → generic bucket
        const key = '0|0'
        if (!episodeMap.has(key)) episodeMap.set(key, [])
        episodeMap.get(key)!.push(makeEpisodeTorrent(t, {
          file_index: null,
          inferred: false,
        }))
      }
      continue
    }

    if (t.episode != null) {
      // Single-episode torrent: direct match
      const key = `${t.season}|${t.episode}`
      if (!episodeMap.has(key)) episodeMap.set(key, [])
      episodeMap.get(key)!.push(makeEpisodeTorrent(t, {
        file_index: 0,
        inferred: false,
      }))
    } else {
      // Season pack (episode is null, season is set)
      // Use coverage to determine which seasons this torrent actually covers
      const coverSeasons =
        coverage && coverage.seasons.length > 1
          ? coverage.seasons
          : [t.season]

      let fileOffset = 0
      for (const s of coverSeasons) {
        const episodesForSeason = Array.from(tmdbEpisodes.entries())
          .filter(([k]) => k.startsWith(`${s}|`))
          .map(([k, tmdb]) => {
            const epNum = parseInt(k.split('|')[1]!, 10)
            return { key: k, episode: epNum, tmdb }
          })

        if (episodesForSeason.length > 0) {
          for (const { key, episode: epNum } of episodesForSeason) {
            if (!episodeMap.has(key)) episodeMap.set(key, [])
            episodeMap.get(key)!.push(makeEpisodeTorrent(t, {
              file_index: fileOffset + (epNum - 1),
              inferred: false,
            }))
          }
          fileOffset += episodesForSeason.length
        } else {
          // We don't know the episode count for this season; still add a generic entry
          const key = `${s}|0`
          if (!episodeMap.has(key)) episodeMap.set(key, [])
          episodeMap.get(key)!.push(makeEpisodeTorrent(t, {
            file_index: null,
            inferred: true,
          }))
        }
      }
    }
  }

  // Convert map to sorted EpisodeInfo array
  const result: EpisodeInfo[] = []
  for (const [key, episodeTorrents] of episodeMap) {
    const [seasonStr, episodeStr] = key.split('|')
    const season = parseInt(seasonStr!, 10)
    const episode = parseInt(episodeStr!, 10)
    const tmdb = tmdbEpisodes.get(key)
    result.push({
      season,
      episode,
      title: tmdb?.title ?? null,
      air_date: tmdb?.air_date ?? null,
      torrents: episodeTorrents.sort((a, b) => b.seeds - a.seeds),
    })
  }

  result.sort((a, b) => a.season - b.season || a.episode - b.episode)

  // Cache resolved episodes
  await cacheResults(contentId, result)

  return result
}

// ─── Strategy B: Heuristic fallback ───────────────────────────────────────

function resolveHeuristic(linked: LinkedTorrent[]): EpisodeInfo[] {
  const episodeMap = new Map<string, EpisodeTorrent[]>()

  for (const t of linked) {
    // Try to parse season/episode from the torrent title
    const parsed = parseRelease(t.title)
    const season = parsed.season ?? 0
    const episode = parsed.episode ?? 0

    const key = `${season}|${episode}`
    if (!episodeMap.has(key)) episodeMap.set(key, [])
    episodeMap.get(key)!.push(makeEpisodeTorrent(t, {
      file_index: season > 0 && episode > 0 ? episode - 1 : null,
      inferred: true,
    }))
  }

  const result: EpisodeInfo[] = []
  for (const [key, episodeTorrents] of episodeMap) {
    const [seasonStr, episodeStr] = key.split('|')
    const season = parseInt(seasonStr!, 10)
    const episode = parseInt(episodeStr!, 10)
    result.push({
      season,
      episode,
      title: null,
      air_date: null,
      torrents: episodeTorrents.sort((a, b) => b.seeds - a.seeds),
    })
  }

  result.sort((a, b) => a.season - b.season || a.episode - b.episode)
  return result
}

// ─── Cache ────────────────────────────────────────────────────────────────

async function cacheResults(contentId: number, episodes: EpisodeInfo[]): Promise<void> {
  try {
    for (const ep of episodes) {
      for (const t of ep.torrents) {
        await db
          .insert(torrent_episodes)
          .values({
            content_id: contentId,
            torrent_hash: t.hash,
            season: ep.season,
            episode: ep.episode,
            file_index: t.file_index,
            inferred: t.inferred,
          })
          .onConflictDoUpdate({
            target: [
              torrent_episodes.content_id,
              torrent_episodes.torrent_hash,
              torrent_episodes.season,
              torrent_episodes.episode,
            ],
            set: {
              file_index: t.file_index,
              inferred: t.inferred,
              resolved_at: new Date(),
            },
          })
      }
    }
  } catch (err) {
    console.warn(`[episodes] Failed to cache episodes for content ${contentId}:`, (err as Error).message)
  }
}
