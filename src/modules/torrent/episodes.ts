import { and, eq, gt, sql } from 'drizzle-orm'
import { db } from '../../db'
import { anime_franchise_entries, contents, content_torrents, torrents, torrent_episodes, metadata_cache } from '../../types'
import { getTV, getSeasonEpisodes } from '../enrichment/tmdb'
import { getAnimeEpisodes, type JikanEpisode } from '../enrichment/myanimelist'
import * as aniskip from '../enrichment/aniskip'
import { parseRelease, hasPortugueseAudio } from '../../lib/parse'
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
  collected_at: string | null
  /** Áudio em português (dublado/dual PT-BR) declarado no título. */
  ptbr_audio: boolean
}

/**
 * Marcadores de tempo do episódio (em segundos), para "Pular abertura" e para
 * disparar o card "Próximo episódio" no início real dos créditos (não em
 * `duração − 60s`). Camadas, da mais precisa p/ a mais grosseira:
 *  - `aniskip`: abertura + créditos exatos (anime, via mal_id)
 *  - `tmdb`:    apenas `runtime_sec` (duração esperada do episódio) como hint
 * O app ainda pode preferir os chapters do próprio arquivo quando existirem.
 */
export interface EpisodeMarkers {
  intro?: { start: number; end: number } | null
  credits?: { start: number } | null
  runtime_sec?: number | null
  source: 'aniskip' | 'tmdb' | 'mixed'
}

export interface EpisodeInfo {
  season: number
  episode: number
  title: string | null
  air_date: string | null
  torrents: EpisodeTorrent[]
  markers?: EpisodeMarkers | null
  filler?: boolean | null
  recap?: boolean | null
  metadata_source?: 'tmdb' | 'jikan' | null
}

interface LinkedTorrent {
  torrent_id: number
  hash: string
  magnet_link: string
  title: string
  seeds: number | null
  size_bytes: number | null
  season: number | null
  episode: number | null
  source: string | null
  collected_at: Date | null
  /** Nomes/tamanhos dos arquivos do torrent (jsonb) — usado p/ achar o arquivo do episódio. */
  file_list?: unknown
}

// ─── Arquivo do episódio dentro de um pack ────────────────────────────────

/**
 * Número do episódio lido do NOME do arquivo. Packs nem sempre vêm em ordem de
 * episódio (ex.: `[IceBlue] … 2º Temporada` = 03, 02, 01, 04…) — o índice
 * posicional tocaria o arquivo errado.
 */
function episodeNumberFromFileName(name: string): number | null {
  // [regex, grupo que carrega o número do EPISÓDIO]. A resolução (1920x1080) fica
  // de fora porque o padrão SxxExx-like exige que o 1º número não tenha dígito antes.
  const patterns: [RegExp, number][] = [
    [/(?<!\d)(\d{1,2})x(\d{1,3})(?!\d)/i, 2], // AoTDublado02x03.mkv → 3
    [/\bS(\d{1,2})E(\d{1,3})\b/i, 2], // S02E03 → 3
    [/\bE(?:p|pisode)?[\s._-]*(\d{1,3})(?:v\d)?\b/i, 1], // Ep03 / Episode 3
    [/\s-\s(\d{1,3})(?:v\d)?\b/i, 1], // "… - 03"
    [/[_\s](\d{1,3})(?:v\d)?\.\w+$/i, 1], // "…_03.mkv"
  ]
  for (const [re, group] of patterns) {
    const m = name.match(re)
    if (m) {
      const n = Number(m[group])
      if (Number.isInteger(n) && n > 0) return n
    }
  }
  return null
}

/** O que o resolver precisa saber de cada vínculo `content_torrents`. */
interface LinkMeta {
  fileList: unknown
  /** Temporada declarada no vínculo — `null` = pack da série toda (COMPLETO). */
  season: number | null
}

interface SeasonIndexEntry {
  season_number: number
  part_number: number
  episode_offset: number
  episode_count: number | null
}

/**
 * O arquivo é um episódio numerado da série? OVA/OAD/especial/extra não são, e o
 * nome deles ("… - OVA 1.mkv") casaria com o episódio 1 da temporada 1.
 */
function isEpisodeFile(path: string): boolean {
  if (!/\.(mkv|mp4|avi|ts|m2ts)$/i.test(path)) return false
  if (/(ova|oad|kuinaki|lost\s*girls|special|nced|ncop|movie|recap|chronicle|preview|menu)/i.test(path)) {
    return false
  }
  return true
}

/**
 * Mapa `número absoluto do episódio → (temporada, episódio)` somando os episódios
 * das entradas da franquia (S1 1-25, S2 26-37, S3 38-59, S4 60-87 no caso de AoT).
 * É como os packs "COMPLETO" numeram seus arquivos.
 */
function buildAbsoluteSeasonIndex(entries: SeasonIndexEntry[]): Map<number, { season: number; episode: number }> {
  const perSeason = new Map<number, number>()
  for (const entry of entries) {
    const length = (entry.episode_offset ?? 0) + (entry.episode_count ?? 0)
    perSeason.set(entry.season_number, Math.max(perSeason.get(entry.season_number) ?? 0, length))
  }
  const index = new Map<number, { season: number; episode: number }>()
  let cumulative = 0
  for (const season of [...perSeason.keys()].sort((a, b) => a - b)) {
    const total = perSeason.get(season) ?? 0
    for (let local = 1; local <= total; local++) {
      index.set(cumulative + local, { season, episode: local })
    }
    cumulative += total
  }
  return index
}

/**
 * Índice (0-based, ordem do torrent) do arquivo que corresponde ao episódio,
 * derivado do `file_list`. `null` quando nenhum arquivo casa — o chamador então
 * usa o índice posicional antigo.
 */
function fileIndexForEpisode(fileList: unknown, episode: number): number | null {
  if (!Array.isArray(fileList) || fileList.length === 0) return null
  for (let i = 0; i < fileList.length; i++) {
    const name = (fileList[i] as { name?: unknown } | null)?.name
    if (typeof name !== 'string' || !isEpisodeFile(name)) continue
    if (episodeNumberFromFileName(name) === episode) return i
  }
  return null
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
    collected_at: t.collected_at ? t.collected_at.toISOString() : null,
    ptbr_audio: hasPortugueseAudio(t.title ?? ''),
  }
}

/**
 * Ordem das fontes de um episódio: áudio PT-BR primeiro (preferência declarada),
 * depois mais seeds, e EZTV (seed sempre 0) por último no empate.
 */
function compareEpisodeSources(a: EpisodeTorrent, b: EpisodeTorrent): number {
  if (a.ptbr_audio !== b.ptbr_audio) return a.ptbr_audio ? -1 : 1
  const seedDiff = b.seeds - a.seeds
  if (seedDiff !== 0) return seedDiff
  const aEztv = a.title?.includes('[EZTV') ? 1 : 0
  const bEztv = b.title?.includes('[EZTV') ? 1 : 0
  return aEztv - bEztv
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
export async function resolveEpisodes(
  contentId: number,
  options: { forceExternal?: boolean } = {},
): Promise<EpisodeInfo[]> {
  // 1. Load content
  const [content] = await db
    .select({ type: contents.type, tmdb_id: contents.tmdb_id, mal_id: contents.mal_id, title: contents.title })
    .from(contents)
    .where(eq(contents.id, contentId))
    .limit(1)
  if (!content || (content.type !== 'series' && content.type !== 'anime')) {
    throw new Error(`Content ${contentId} is not a series or anime`)
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
      source: torrents.source,
      collected_at: torrents.collected_at,
      file_list: torrents.file_list,
    })
    .from(content_torrents)
    .innerJoin(torrents, eq(torrents.id, content_torrents.torrent_id))
    .where(eq(content_torrents.content_id, contentId))

  // Metadados por hash: `file_list` deixa o pack apontar o arquivo certo do
  // episódio mesmo quando a ordem do torrent não é a dos episódios, e a
  // temporada declarada em `content_torrents` distingue pack de temporada de
  // pack "COMPLETO" (temporada nula → numeração absoluta).
  const linkMeta = new Map<string, LinkMeta>()
  for (const t of linked) {
    linkMeta.set(t.hash, { fileList: t.file_list ?? null, season: t.season })
  }

  // 3. Resolve episodes (TMDB first, heuristic fallback)
  let episodes: EpisodeInfo[]
  if (content.tmdb_id) {
    try {
      episodes = await resolveWithTmdb(contentId, content.tmdb_id, linked)
    } catch (err) {
      console.warn(
        `[episodes] TMDB resolution failed for content ${contentId} (tmdb:${content.tmdb_id}):`,
        (err as Error).message,
      )
      episodes = resolveHeuristic(linked)
    }
  } else {
    episodes = resolveHeuristic(linked)
  }

  // Anime sem TMDB ainda precisa exibir o catálogo externo inteiro, inclusive
  // episódios sem fonte. Jikan fornece a lista; os torrents já resolvidos são
  // mesclados pelo número do episódio.
  if (!content.tmdb_id && content.mal_id) {
    episodes = await mergeJikanCatalog(contentId, content.mal_id, episodes, !!options.forceExternal, linkMeta)
  }

  // 4. Best-effort: anexa marcadores de abertura/créditos via AniSkip (anime com
  //    mal_id). Cacheado em metadata_cache; o runtime do TMDB já foi anexado em
  //    resolveWithTmdb. Nunca lança — marcadores são um "nice to have".
  if (content.mal_id) {
    const franchise = await db
      .select()
      .from(anime_franchise_entries)
      .where(eq(anime_franchise_entries.content_id, contentId))
    if (franchise.length > 0) {
      for (const entry of franchise) {
        const seasonEpisodes = episodes.filter(
          (episode) =>
            episode.season === entry.season_number &&
            episode.episode > entry.episode_offset &&
            (entry.episode_count == null ||
              episode.episode <= entry.episode_offset + entry.episode_count),
        )
        await attachAniskipMarkers(entry.mal_id, seasonEpisodes, entry.episode_offset)
      }
    } else {
      await attachAniskipMarkers(content.mal_id, episodes)
    }
  }

  // Ordena as fontes de cada episódio (PT-BR primeiro) — a lista é montada em
  // três caminhos diferentes (TMDB, heurístico e franquia) e o pack completo é
  // anexado no fim, então a ordenação é feita uma vez, aqui.
  for (const episode of episodes) {
    episode.torrents.sort(compareEpisodeSources)
  }

  return episodes
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
  const tmdbEpisodes = new Map<
    string,
    { title: string | null; air_date: string | null; runtime: number | null }
  >()

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
            runtime: typeof ep.runtime === 'number' ? ep.runtime : null,
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

  // A lista visual deve nascer do catálogo externo, não dos torrents. Assim um
  // episódio novo aparece imediatamente como indisponível enquanto a busca de
  // fontes está em andamento (ou quando nenhuma fonte foi encontrada).
  for (const key of tmdbEpisodes.keys()) {
    if (!episodeMap.has(key)) episodeMap.set(key, [])
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
    const runtimeSec = tmdb?.runtime ? tmdb.runtime * 60 : null
    result.push({
      season,
      episode,
      title: tmdb?.title ?? null,
      air_date: tmdb?.air_date ?? null,
      torrents: episodeTorrents.sort((a, b) => {
        // Prefer higher seeds; tie-break: non-EZTV sources first (SolidTorrents has real seed data)
        const seedDiff = b.seeds - a.seeds
        if (seedDiff !== 0) return seedDiff
        const aIsEztv = a.title?.includes('[EZTV') ? 1 : 0
        const bIsEztv = b.title?.includes('[EZTV') ? 1 : 0
        return aIsEztv - bIsEztv
      }),
      markers: runtimeSec ? { runtime_sec: runtimeSec, source: 'tmdb' } : null,
      metadata_source: 'tmdb',
    })
  }

  result.sort((a, b) => a.season - b.season || a.episode - b.episode)

  // Cache resolved episodes
  await cacheResults(contentId, result)

  return result
}

// ─── Jikan episode catalog ────────────────────────────────────────────────

const JIKAN_EPISODE_CACHE_HOURS = 6

async function loadJikanCatalog(malId: number, force: boolean): Promise<JikanEpisode[]> {
  const key = String(malId)
  if (!force) {
    const cutoff = new Date(Date.now() - JIKAN_EPISODE_CACHE_HOURS * 60 * 60 * 1000)
    const rows = await db
      .select({ response: metadata_cache.response })
      .from(metadata_cache)
      .where(
        and(
          eq(metadata_cache.source, 'jikan-episodes'),
          eq(metadata_cache.lookup_key, key),
          gt(metadata_cache.cached_at, cutoff),
        ),
      )
      .limit(1)
    if (Array.isArray(rows[0]?.response)) return rows[0]!.response as JikanEpisode[]
  }

  const fetched = await getAnimeEpisodes(malId)
  if (fetched.length > 0) {
    await db
      .insert(metadata_cache)
      .values({ source: 'jikan-episodes', lookup_key: key, response: fetched })
      .onConflictDoUpdate({
        target: [metadata_cache.source, metadata_cache.lookup_key],
        set: { response: fetched, cached_at: sql`now()` },
      })
  }
  return fetched
}

async function mergeJikanCatalog(
  contentId: number,
  malId: number,
  existing: EpisodeInfo[],
  force: boolean,
  linkMeta: Map<string, LinkMeta> = new Map(),
): Promise<EpisodeInfo[]> {
  let franchise = await db
    .select()
    .from(anime_franchise_entries)
    .where(eq(anime_franchise_entries.content_id, contentId))
  const hasFranchise = franchise.length > 0
  if (franchise.length === 0) {
    franchise = [{
      content_id: contentId,
      mal_id: malId,
      season_number: 1,
      part_number: 1,
      episode_offset: 0,
      title: '',
      title_english: null,
      title_japanese: null,
      year: null,
      episode_count: null,
      updated_at: new Date(),
    }]
  }

  const byEpisode = new Map<string, EpisodeInfo>()
  for (const ep of existing) {
    if (ep.episode > 0) byEpisode.set(`${ep.season}|${ep.episode}`, ep)
  }

  for (const entry of franchise) {
    // A contagem oficial da entrada é suficiente para montar o catálogo mesmo
    // quando `/episodes` está em 429/504. Os metadados detalhados abaixo apenas
    // enriquecem esses placeholders.
    for (let localNumber = 1; localNumber <= (entry.episode_count ?? 0); localNumber++) {
      const number = entry.episode_offset + localNumber
      const key = `${entry.season_number}|${number}`
      if (!byEpisode.has(key)) {
        byEpisode.set(key, {
          season: entry.season_number,
          episode: number,
          title: null,
          air_date: null,
          torrents: [],
          metadata_source: 'jikan',
        })
      }
    }

    const external = await loadJikanCatalog(entry.mal_id, force)
    for (const item of external) {
      const localNumber = item.mal_id
      if (!Number.isInteger(localNumber) || localNumber <= 0) continue
      // Jikan ocasionalmente concatena/repete o cour seguinte no endpoint de
      // uma parte (MAL 39551 já retornou 33 itens para uma entrada de 12).
      if (entry.episode_count != null && localNumber > entry.episode_count) continue
      const number = entry.episode_offset + localNumber
      const key = `${entry.season_number}|${number}`
      const current = byEpisode.get(key)
      byEpisode.set(key, {
        season: entry.season_number,
        episode: number,
        title: item.title ?? item.title_romanji ?? current?.title ?? null,
        air_date: item.aired ?? current?.air_date ?? null,
        torrents: current?.torrents ?? [],
        markers: current?.markers ?? null,
        filler: item.filler ?? null,
        recap: item.recap ?? null,
        metadata_source: 'jikan',
      })
    }
  }

  // Packs não representam "episódio 0": distribui a fonte pelos episódios da
  // temporada ou somente pelo cour indicado no nome do release.
  for (const generic of existing.filter((episode) => episode.episode <= 0 && episode.season > 0)) {
    for (const torrent of generic.torrents) {
      const partMatch = torrent.title.match(/\bpart\s*(\d{1,2})\b/i)
      const part = partMatch ? Number(partMatch[1]) : null
      const entry = part == null
        ? null
        : franchise.find(
            (candidate) =>
              candidate.season_number === generic.season && candidate.part_number === part,
          )
      // Faixa de episódios no título: " - 01 ~ 12", "S01E01-12" e o formato
      // brasileiro "(01-12)" / "(13-22)" — sem isso, os dois packs de uma
      // temporada dividida em partes se espalham pelos episódios um do outro.
      const range =
        torrent.title.match(/\s-\s(?:s\d{1,2}e)?(\d{1,3})\s*[~–-]\s*(?:s\d{1,2}e)?(\d{1,3})\b/i) ??
        torrent.title.match(/\bs\d{1,2}e(\d{1,3})\s*-\s*(?:s\d{1,2}e)?(\d{1,3})\b/i) ??
        torrent.title.match(/\((\d{1,3})\s*[~–-]\s*(\d{1,3})\)/)
      const offset = entry?.episode_offset ?? 0
      const start = range ? offset + Number(range[1]) : offset + 1
      const end = range
        ? offset + Number(range[2])
        : entry?.episode_count != null
          ? entry.episode_offset + entry.episode_count
          : Number.POSITIVE_INFINITY
      for (const episode of byEpisode.values()) {
        if (episode.season !== generic.season || episode.episode < start || episode.episode > end) {
          continue
        }
        if (episode.torrents.some((candidate) => candidate.hash === torrent.hash)) continue
        episode.torrents.push({
          ...torrent,
          // O pack pode não estar em ordem de episódio: prefere o arquivo cujo
          // nome casa com o episódio; sem `file_list`, mantém o índice posicional.
          file_index:
            fileIndexForEpisode(linkMeta.get(torrent.hash)?.fileList, episode.episode) ??
            episode.episode - start,
          inferred: true,
        })
      }
    }
  }

  // Pack "COMPLETO" (temporada nula no vínculo): a numeração dos arquivos é
  // ABSOLUTA na série (S1 01-25, S2 26-37, S3 38-59, S4 60-87), então cada
  // arquivo vai para o (temporada, episódio) calculado pela soma dos episódios
  // das entradas da franquia — com o índice REAL do arquivo no torrent.
  // Arquivos que não são episódio (OVA, filme, special) ficam de fora.
  const absoluteIndex = buildAbsoluteSeasonIndex(franchise)
  for (const pack of existing.filter((episode) => episode.episode <= 0)) {
    for (const torrent of pack.torrents) {
      const meta = linkMeta.get(torrent.hash)
      if (!meta || meta.season != null || !Array.isArray(meta.fileList)) continue
      const files = meta.fileList as { name?: unknown }[]
      for (let i = 0; i < files.length; i++) {
        const name = files[i]?.name
        if (typeof name !== 'string' || !isEpisodeFile(name)) continue
        const absolute = episodeNumberFromFileName(name)
        if (absolute == null) continue
        const target = absoluteIndex.get(absolute)
        if (!target) continue
        const episode = byEpisode.get(`${target.season}|${target.episode}`)
        if (!episode) continue
        if (episode.torrents.some((candidate) => candidate.hash === torrent.hash)) continue
        episode.torrents.push({ ...torrent, file_index: i, inferred: true })
      }
    }
  }

  // Packs sem episódio específico continuam disponíveis no detalhe/fontes,
  // mas não viram um card falso "Episódio 0" quando há catálogo de franquia.
  const generic = hasFranchise ? [] : existing.filter((ep) => ep.episode <= 0)
  return [...byEpisode.values(), ...generic].sort(
    (a, b) => a.season - b.season || a.episode - b.episode,
  )
}

// ─── Strategy B: Heuristic fallback ───────────────────────────────────────

function resolveHeuristic(linked: LinkedTorrent[]): EpisodeInfo[] {
  const episodeMap = new Map<string, EpisodeTorrent[]>()

  for (const t of linked) {
    // Try to parse season/episode from the torrent title
    const parsed = parseRelease(t.title)
    // O vínculo já contém a temporada lógica definida pela franquia. Ela tem
    // precedência porque releases `Title - 01` não carregam Sxx e antes eram
    // exibidos incorretamente como "temporada 0".
    const season = t.season ?? parsed.season ?? 0
    // `episode = null` com temporada conhecida representa pack; não deixe o
    // parser transformar o início de um range (`01 ~ 12`) em episódio único.
    const episode = t.season != null ? (t.episode ?? 0) : (parsed.episode ?? 0)

    // Torrent de arquivo único (release por episódio): o arquivo é o índice 0.
    // Sem isso o vínculo por episódio herdava `episodio - 1` e apontava para um
    // arquivo que não existe dentro do torrent.
    const singleFile = Array.isArray(t.file_list) && (t.file_list as unknown[]).length === 1

    const key = `${season}|${episode}`
    if (!episodeMap.has(key)) episodeMap.set(key, [])
    episodeMap.get(key)!.push(makeEpisodeTorrent(t, {
      file_index: singleFile ? 0 : season > 0 && episode > 0 ? episode - 1 : null,
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
      torrents: episodeTorrents.sort((a, b) => {
        const seedDiff = b.seeds - a.seeds
        if (seedDiff !== 0) return seedDiff
        const aIsEztv = a.title?.includes('[EZTV') ? 1 : 0
        const bIsEztv = b.title?.includes('[EZTV') ? 1 : 0
        return aIsEztv - bIsEztv
      }),
    })
  }

  result.sort((a, b) => a.season - b.season || a.episode - b.episode)
  return result
}

// ─── Marcadores: AniSkip (abertura/créditos) ───────────────────────────────

/** Lê do metadata_cache; busca no AniSkip e cacheia (incl. "vazio") em miss. */
async function cachedAniskip(
  malId: number,
  episode: number,
): Promise<aniskip.AniSkipMarkers | null> {
  const key = `${malId}:${episode}`
  const rows = await db
    .select({ response: metadata_cache.response })
    .from(metadata_cache)
    .where(and(eq(metadata_cache.source, 'aniskip'), eq(metadata_cache.lookup_key, key)))
    .limit(1)
  if (rows[0]?.response) {
    const r = rows[0].response as aniskip.AniSkipMarkers & { _none?: boolean }
    return r._none ? null : r
  }

  const fetched = await aniskip.getSkipTimes(malId, episode, 0)
  // Cacheia inclusive o "não encontrado" (_none) p/ não re-bater no 404 a cada request.
  const toStore = fetched ?? { _none: true }
  await db
    .insert(metadata_cache)
    .values({ source: 'aniskip', lookup_key: key, response: toStore })
    .onConflictDoUpdate({
      target: [metadata_cache.source, metadata_cache.lookup_key],
      set: { response: toStore, cached_at: sql`now()` },
    })
  return fetched
}

/**
 * Anexa abertura/créditos do AniSkip a cada episódio (best-effort).
 * Nota: o AniSkip indexa por número de episódio do MAL (geralmente por cour/
 * temporada). Para séries multi-temporada sob um único mal_id o casamento é
 * aproximado — por isso é só um marcador, com fallback no app.
 */
async function attachAniskipMarkers(
  malId: number,
  episodes: EpisodeInfo[],
  episodeOffset = 0,
): Promise<void> {
  for (const ep of episodes) {
    if (ep.season === 0 || ep.episode === 0) continue
    try {
      const sk = await cachedAniskip(malId, ep.episode - episodeOffset)
      if (!sk) continue
      const m: EpisodeMarkers = ep.markers ?? { source: 'aniskip' }
      if (sk.introStart != null && sk.introEnd != null) {
        m.intro = { start: sk.introStart, end: sk.introEnd }
      }
      if (sk.creditsStart != null) m.credits = { start: sk.creditsStart }
      m.source = ep.markers ? 'mixed' : 'aniskip'
      ep.markers = m
    } catch (err) {
      console.warn(`[episodes] aniskip marker failed (mal:${malId} ep:${ep.episode}):`, (err as Error).message)
    }
  }
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
