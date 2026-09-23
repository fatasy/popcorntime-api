import { and, eq, isNotNull, isNull, desc, inArray, or, sql } from 'drizzle-orm'
import { db } from '../../db'
import { anime_franchise_entries, contents, torrents, content_torrents } from '../../types'
import { parseRelease } from '../../lib/parse'
import type { RawTorrent } from '../../lib/parse'
import { detectGaps } from './gap-detector'
import type { SeasonGap, GapResult } from './gap-detector'
import { fetchEztvByImdb } from './sources/eztv'
import { searchSolidTorrents } from './sources/solidtorrents'
import { searchNyaa } from './sources/nyaa'
import { getSeasonNow } from '../enrichment/myanimelist'

// ─── Types ──────────────────────────────────────────────────────────────────

export interface FillResult {
  seriesId: number
  title: string
  torrentsAdded: number
}

export interface FillGapsOptions {
  /** Processa somente este conteúdo (usado pela atualização manual da tela de detalhes). */
  contentId?: number
  /** Ignora o cache do catálogo externo de temporadas/episódios. */
  forceCatalog?: boolean
  /** Limite por conteúdo; o pipeline regular continua conservador em 8 episódios. */
  maxEpisodesPerContent?: number
  /**
   * Força uma nova busca para um episódio específico, mesmo quando ele já tem
   * fontes. Usado pelo botão "Adicionar fontes" do card do episódio.
   */
  targetEpisode?: { season: number; episode: number }
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
  /\bS\d{1,2}\b(?!E)/i,
  /\bBATCH\b/i,
  /\b\d{1,3}\s*[~–]\s*\d{1,3}\b/i,
]

function isPack(title: string): boolean {
  return PACK_PATTERNS.some((re) => re.test(title))
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function padTwo(n: number): string {
  return String(n).padStart(2, '0')
}

function explicitAnimeSeason(title: string): number | null {
  const match =
    title.match(/\bs(\d{1,2})(?:e\d+)?\b/i) ??
    title.match(/\bseason\s*(\d{1,2})\b/i) ??
    title.match(/\b(\d{1,2})(?:st|nd|rd|th)\s+season\b/i)
  return match ? Number(match[1]) : null
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
export async function fillGaps(
  limit = 5,
  options: FillGapsOptions = {},
): Promise<FillResult[]> {
  const evalLimit = limit * 4

  // Priority candidates: currently-airing anime (Jikan season_now) matched by
  // mal_id. These are the ones dropping a weekly episode that the user actually
  // cares about. Ordering the general window by id DESC never reaches them,
  // because airing anime carry LOW content ids (created before months of junk).
  let priority: Array<{ id: number; title: string; imdb_id: string | null; type: string; mal_id: number | null; coverage: number }> = []
  if (options.contentId == null) try {
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
          coverage: sql<number>`(select count(*) from content_torrents ct where ct.content_id = ${contents.id})`,
        })
        .from(contents)
        .where(
          and(
            eq(contents.type, 'anime'),
            isNull(contents.canonical_content_id),
            isNotNull(contents.enriched_at),
            inArray(contents.mal_id, airingMal),
          ),
        )
      const consolidatedAiring = await db
        .select({
          id: contents.id,
          title: contents.title,
          imdb_id: contents.imdb_id,
          type: contents.type,
          mal_id: contents.mal_id,
          coverage: sql<number>`(select count(*) from content_torrents ct where ct.content_id = ${contents.id})`,
        })
        .from(anime_franchise_entries)
        .innerJoin(contents, eq(contents.id, anime_franchise_entries.content_id))
        .where(inArray(anime_franchise_entries.mal_id, airingMal))
      priority.push(...consolidatedAiring)
      console.log(`[fillGaps] ${priority.length} currently-airing anime candidates`)
    }
  } catch (err) {
    console.warn('[fillGaps] failed to fetch airing anime:', (err as Error).message)
  }

  // General window: series that can be filled (tmdb + imdb for EZTV) and real
  // enriched anime (mal for Jikan detect + nyaa fill). Excludes the unmatchable
  // apibay junk piles that can't be filled anyway.
  //
  // Ordered by LEAST-COVERAGE FIRST (fewest linked content_torrents), then
  // newest: a content with zero/one episode floats to the top regardless of how
  // old its content id is. Previously this was `orderBy(desc(id))`, so old
  // enriched anime (Re:Zero #398, Witch Hat #397, Mushoku #1201...) never
  // entered the window and stayed permanently empty. Now the emptiest contents
  // get filled first, and after each run they sink back down.
  const baseSelection = {
    id: contents.id,
    title: contents.title,
    imdb_id: contents.imdb_id,
    type: contents.type,
    mal_id: contents.mal_id,
    coverage: sql<number>`(select count(*) from content_torrents ct where ct.content_id = ${contents.id})`,
  }
  const general = options.contentId != null
    ? await db
        .select(baseSelection)
        .from(contents)
        .where(eq(contents.id, options.contentId))
        .limit(1)
    : await db
        .select(baseSelection)
        .from(contents)
        .where(
          and(
            inArray(contents.type, ['series', 'anime']),
            isNull(contents.canonical_content_id),
            or(
              and(eq(contents.type, 'series'), isNotNull(contents.tmdb_id), isNotNull(contents.imdb_id)),
              and(eq(contents.type, 'anime'), isNotNull(contents.mal_id), isNotNull(contents.enriched_at)),
            ),
          ),
        )
        .orderBy(
          sql`coalesce(${sql`(select count(*) from content_torrents ct where ct.content_id = ${contents.id})`}, 999999) asc`,
          desc(contents.id),
        )
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
    if (options.targetEpisode) {
      const target = options.targetEpisode
      const gap: SeasonGap = {
        season: target.season,
        episodes: [target.episode],
      }

      // Para anime, o episódio lógico pode pertencer a uma parte/cour com
      // título e numeração próprios. A busca direcionada precisa usar essa
      // entrada — por exemplo T2E13 vira episódio 1 da parte 2.
      if (series.type === 'anime') {
        const entries = await db
          .select()
          .from(anime_franchise_entries)
          .where(eq(anime_franchise_entries.content_id, contentId))
        const entry = entries
          .filter((item) => item.season_number === target.season)
          .sort((a, b) => b.episode_offset - a.episode_offset)
          .find(
            (item) =>
              target.episode > item.episode_offset &&
              (item.episode_count == null ||
                target.episode <= item.episode_offset + item.episode_count),
          )
        if (entry) {
          gap.searchTitle = entry.title
          gap.episodeOffset = entry.episode_offset
          gap.malId = entry.mal_id
        }
      }

      result = { gaps: [gap], isAiring: false }
    } else {
      try {
        result = await detectGaps(contentId, { force: options.forceCatalog })
      } catch (err) {
        console.warn(
          `[fillGaps] detectGaps failed for "${seriesTitle}" (id=${contentId}):`,
          (err as Error).message,
        )
        continue
      }
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

  // 3. Sort: LEAST-COVERAGE FIRST (fewest linked content_torrents) so anything
  //    with zero/one episode is filled before well-covered content — the user's
  //    rule: "se tem algo no catalogo, nao pode ficar sem conteudo." Airing
  //    anime then take precedence within the same coverage bucket (weekly eps),
  //    anime before series, then by FEWEST missing episodes so a huge backfill
  //    doesn't block weekly anime that need one ep.
  candidates.sort((a, b) => {
    const aCov = a.series.coverage ?? 0
    const bCov = b.series.coverage ?? 0
    if (aCov !== bCov) return aCov - bCov
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
    let budget = options.maxEpisodesPerContent ?? MAX_GAP_EPISODES_PER_RUN
    for (const g of candidate.gaps) {
      if (budget <= 0) break
      const slice = g.episodes.slice(0, budget)
      budget -= slice.length
      caps.push({ ...g, episodes: slice })
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
      // Cada MAL id é uma temporada/parte diferente. A busca usa o título
      // externo daquela entrada, mas todos os resultados são ligados ao mesmo
      // conteúdo canônico e à temporada lógica correta.
      for (const gap of gaps) {
        const targetSeason = gap.season > 0 ? gap.season : 1
        const searchTitle = gap.searchTitle ?? seriesTitle
        const episodeOffset = gap.episodeOffset ?? 0
        const queries = [searchTitle]
        if (!/\bseason\b|\b\d+(?:st|nd|rd|th) season\b/i.test(searchTitle)) {
          queries.push(`${searchTitle} S${padTwo(targetSeason)}`)
        }

        const nyRes = new Map<string, RawTorrent>()
        for (const q of queries) {
          try {
            const results = await searchNyaa(q, 50)
            for (const torrent of results) if (!nyRes.has(torrent.hash)) nyRes.set(torrent.hash, torrent)
          } catch (err) {
            console.warn(`[fillGaps] nyaa search failed for "${q}":`, (err as Error).message)
          }
        }

        const missing = new Set(gap.episodes)
        for (const torrent of nyRes.values()) {
          if ((torrent.seeds ?? 0) < 1) continue
          const parsed = parseRelease(torrent.title)
          if (parsed.episode == null) continue
          const releaseSeason = parsed.season ?? explicitAnimeSeason(torrent.title)
          // Catálogos de anime frequentemente tratam cada entrada MAL como uma
          // série independente e rotulam a 2ª/3ª temporada canônica como S01.
          // Como a consulta já usa o título específico da entrada, S01 também
          // é válido nesse caso.
          if (
            releaseSeason != null &&
            releaseSeason !== targetSeason &&
            !(gap.malId != null && releaseSeason === 1)
          ) continue
          const rawEpisode = Number(parsed.episode)
          const episode = missing.has(rawEpisode)
            ? rawEpisode
            : rawEpisode + episodeOffset
          if (!missing.has(episode)) continue
          matched.push({ torrent, season: targetSeason, episode })
        }

        const packQuery = `${searchTitle} S${padTwo(targetSeason)}`
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
              season: targetSeason,
              episode: -1, // season pack
            })
          }
          if (viablePacks.length > 0) {
            console.log(
              `[fillGaps] "${searchTitle}": found ${viablePacks.length} nyaa season pack(s)`,
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
          // EZTV já retorna todas as qualidades do episódio numa única chamada
          // por série. Só consulta SolidTorrents quando o episódio realmente
          // ficou sem resultado; isso mantém a atualização manual dentro do
          // tempo de uma request mesmo em temporadas grandes.
          if (eztvMatches.length === 0) {
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
