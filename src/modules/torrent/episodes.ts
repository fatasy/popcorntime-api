import { and, eq, inArray, sql } from 'drizzle-orm'
import { db } from '../../db'
import { anime_franchise_entries, contents, content_torrents, torrents, torrent_episodes, metadata_cache, http_streams } from '../../types'
import { mergeHttpEpisodeSources, type HttpEpisodeSource } from '../streams/episodes'
import type { JikanEpisode } from '../enrichment/myanimelist'
import { cachedAnimeEpisodes, cachedTV, cachedSeasonEpisodes } from './catalog-cache'
import { indexedPackEpisodes } from './pack-files'
import { BackgroundRefreshQueue } from '../../lib/background-refresh'
import * as aniskip from '../enrichment/aniskip'
import { parseRelease, hasPortugueseAudio } from '../../lib/parse'
import {
  resolveEpisodeMetadata,
  type TmdbEpisodeRecord,
  type EpisodeMetadataContext,
} from './episode-metadata'
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
  streams?: HttpEpisodeSource[]
  markers?: EpisodeMarkers | null
  // ─── Metadado externo por episódio (persistido em `episode_metadata`) ───
  // Fontes: TMDB (título pt-BR/sinopse/still), Jikan-MAL (título/data/filler),
  // TVMaze (imagem horizontal por episódio) e TheTVDB (arte, opcional).
  overview?: string | null
  /** Still REAL deste episódio, quando alguma fonte tem arte por episódio. */
  still_url?: string | null
  /** Miniatura para o app: o still quando existe, senão a arte do conteúdo. */
  thumbnail_url?: string | null
  /**
   * Estado da imagem — contrato estável:
   *  - `still`    → `still_url` é a arte DESTE episódio (`image_source` diz de quem)
   *  - `fallback` → não há still; `thumbnail_url` é o poster/backdrop do conteúdo
   *  - `none`     → nenhuma imagem; o app deve usar o placeholder local
   */
  image_kind?: 'still' | 'fallback' | 'none'
  image_source?: 'tmdb' | 'tvmaze' | 'thetvdb' | null
  /** Como o provedor foi vinculado ao conteúdo (auditoria; 'title' só em anime). */
  image_match?: 'tmdb' | 'imdb' | 'thetvdb' | 'title' | null
  /** Atribuição exigida pela fonte da imagem (ex.: TVmaze, CC BY-SA). */
  image_credit?: string | null
  image_credit_url?: string | null
  image_license?: string | null
  runtime_sec?: number | null
  filler?: boolean | null
  recap?: boolean | null
  metadata_source?: 'tmdb' | 'jikan' | 'tvmaze' | 'thetvdb' | null
}

/**
 * Campos de metadado/arte antes de qualquer provedor responder. A miniatura já
 * sai com a arte do conteúdo (backdrop/poster) marcada como `image_kind:
 * 'fallback'` — nunca como still do episódio; sem arte alguma, `image_kind`
 * fica 'none' e o app usa o placeholder local.
 */
function emptyEpisodeMetadata(fallbackArt: string | null): Pick<
  EpisodeInfo,
  | 'overview'
  | 'still_url'
  | 'thumbnail_url'
  | 'image_kind'
  | 'image_source'
  | 'image_match'
  | 'image_credit'
  | 'image_credit_url'
  | 'image_license'
  | 'runtime_sec'
  | 'filler'
  | 'recap'
  | 'metadata_source'
> {
  return {
    overview: null,
    still_url: null,
    thumbnail_url: fallbackArt,
    image_kind: fallbackArt ? 'fallback' : 'none',
    image_source: null,
    image_match: null,
    image_credit: null,
    image_credit_url: null,
    image_license: null,
    runtime_sec: null,
    filler: null,
    recap: null,
    metadata_source: null,
  }
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
    .select({
      type: contents.type,
      tmdb_id: contents.tmdb_id,
      mal_id: contents.mal_id,
      title: contents.title,
      original_title: contents.original_title,
      year: contents.year,
      imdb_id: contents.imdb_id,
      poster_url: contents.poster_url,
      backdrop_url: contents.backdrop_url,
    })
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
  // Arte de fallback das miniaturas (backdrop 16:9 preferido; senão o poster).
  // Usada apenas quando NENHUMA fonte tem still do episódio — e sempre marcada
  // como `image_kind: 'fallback'`, nunca como still.
  const fallbackArt = content.backdrop_url ?? content.poster_url ?? null

  // 3. Resolve episodes (TMDB first, heuristic fallback)
  let episodes: EpisodeInfo[]
  let tmdbRecords: TmdbEpisodeRecord[] | undefined
  // imdb_id do TMDB (`append_to_response=external_ids`): permite vincular o
  // TVMaze por id externo mesmo quando `contents.imdb_id` está vazio.
  let externalImdbId: string | null = null
  if (content.tmdb_id) {
    try {
      const resolved = await resolveWithTmdb(contentId, content.tmdb_id, linked, fallbackArt, !!options.forceExternal, content.type === 'anime')
      episodes = resolved.episodes
      tmdbRecords = resolved.tmdbRecords
      externalImdbId = resolved.externalImdbId
    } catch (err) {
      console.warn(
        `[episodes] TMDB resolution failed for content ${contentId} (tmdb:${content.tmdb_id}):`,
        (err as Error).message,
      )
      episodes = resolveHeuristic(linked, fallbackArt)
    }
  } else {
    episodes = resolveHeuristic(linked, fallbackArt)
  }

  // Anime sem TMDB ainda precisa exibir o catálogo externo inteiro, inclusive
  // episódios sem fonte. Jikan fornece a lista; os torrents já resolvidos são
  // mesclados pelo número do episódio.
  if (!content.tmdb_id && content.mal_id) {
    episodes = await mergeJikanCatalog(contentId, content.mal_id, episodes, !!options.forceExternal, linkMeta, fallbackArt)
  }

  if (content.type === 'anime') {
    const streams = await db.select().from(http_streams).where(eq(http_streams.content_id, contentId))
    episodes = mergeHttpEpisodeSources(episodes, streams)
  }
  // Fontes HTTP podem acrescentar episódios fora do catálogo externo.
  episodes = episodes.map((episode) => ({ ...emptyEpisodeMetadata(fallbackArt), ...episode }))

  // 3b. Metadado externo por episódio (título/sinopse/data + still/thumbnail),
  //     persistido em `episode_metadata`. Para anime keyed por mal_id esta é a
  //     única fonte de título/imagem (o fallback heurístico não tinha nenhuma).
  const metaContext: EpisodeMetadataContext = {
    id: contentId,
    type: content.type,
    title: content.title,
    original_title: content.original_title,
    year: content.year,
    tmdb_id: content.tmdb_id,
    mal_id: content.mal_id,
    imdb_id: content.imdb_id,
    external_imdb_id: externalImdbId,
    poster_url: content.poster_url,
    backdrop_url: content.backdrop_url,
  }
  await resolveEpisodeMetadata(metaContext, episodes, tmdbRecords, { cacheOnly: !options.forceExternal })

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
        await attachAniskipMarkers(entry.mal_id, seasonEpisodes, entry.episode_offset, !!options.forceExternal)
      }
    } else {
      await attachAniskipMarkers(content.mal_id, episodes, 0, !!options.forceExternal)
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
  fallbackArt: string | null,
  forceExternal = false,
  isAnime = false,
): Promise<{
  episodes: EpisodeInfo[]
  tmdbRecords: TmdbEpisodeRecord[]
  externalImdbId: string | null
}> {
  // Fetch TV details to get season list
  const tv = await cachedTV(tmdbId, forceExternal)
  if (!tv) throw new Error('TMDB catalog is warming in the background')

  // `external_ids` vem no mesmo request (append_to_response): id externo do
  // IMDb para vincular provedores de arte por id (nunca por nome) em séries.
  const externalImdbId: string | null = tv?.external_ids?.imdb_id ?? null

  // Build a map of (season, episode) → TMDB episode data
  const tmdbEpisodes = new Map<
    string,
    {
      id: number | null
      title: string | null
      air_date: string | null
      runtime: number | null
      overview: string | null
      still_path: string | null
    }
  >()

  // Fetch each season's episode list in parallel
  const seasons = tv.seasons ?? []
  const seasonRequests = seasons
    .filter((s: any) => s.season_number > 0) // skip specials (season 0)
    .map(async (s: any) => {
      const seasonNum: number = s.season_number
      // The persisted season count is enough to show the full catalog while
      // episode titles/artwork are being refreshed, including missing sources.
      for (let episode = 1; episode <= (s.episode_count ?? 0); episode++) {
        tmdbEpisodes.set(`${seasonNum}|${episode}`, {
          id: null, title: null, air_date: null, runtime: null, overview: null, still_path: null,
        })
      }
      try {
        const data = await cachedSeasonEpisodes(tmdbId, seasonNum, forceExternal)
        for (const ep of data?.episodes ?? []) {
          const key = `${seasonNum}|${ep.episode_number}`
          tmdbEpisodes.set(key, {
            id: typeof ep.id === 'number' ? ep.id : null,
            title: ep.name ?? null,
            air_date: ep.air_date ?? null,
            runtime: typeof ep.runtime === 'number' ? ep.runtime : null,
            overview: ep.overview ?? null,
            still_path: ep.still_path ?? null,
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
      const coverage = await classifySeasonCoverage(t.title, tmdbId,
        tv.number_of_seasons ?? seasons.filter((s: any) => s.season_number > 0).length)
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

    if (t.episode == null) {
      const indexed = indexedPackEpisodes(t.file_list, {
        linkedSeason: t.season, singleSeasonAnime: isAnime && seasons.filter((season: any) => season.season_number > 0).length === 1,
        isEpisodeFile, episodeNumber: episodeNumberFromFileName,
      })
      if (indexed) {
        for (const file of indexed) {
          const key = `${file.season}|${file.episode}`
          if (!tmdbEpisodes.has(key)) continue
          episodeMap.get(key)!.push(makeEpisodeTorrent(t, { file_index: file.fileIndex, inferred: false }))
        }
        continue
      }
    }

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
      ...emptyEpisodeMetadata(fallbackArt),
      metadata_source: 'tmdb',
    })
  }

  result.sort((a, b) => a.season - b.season || a.episode - b.episode)

  // Episódios do TMDB já baixados nesta requisição (inclui still/sinopse):
  // passados para a persistência em `episode_metadata` sem nova chamada à API.
  const tmdbRecords: TmdbEpisodeRecord[] = Array.from(tmdbEpisodes.entries()).map(([key, e]) => {
    const [seasonStr, episodeStr] = key.split('|')
    return {
      season: parseInt(seasonStr!, 10),
      episode: parseInt(episodeStr!, 10),
      source_episode_id: e.id,
      title: e.title,
      overview: e.overview,
      air_date: e.air_date,
      runtime_sec: e.runtime != null ? e.runtime * 60 : null,
      still_path: e.still_path,
    }
  })

  // Cache resolved episodes
  await cacheResults(contentId, result)

  return { episodes: result, tmdbRecords, externalImdbId }
}

// ─── Jikan episode catalog ────────────────────────────────────────────────

async function loadJikanCatalog(malId: number, force: boolean): Promise<JikanEpisode[]> {
  return cachedAnimeEpisodes(malId, force)
}

async function mergeJikanCatalog(
  contentId: number,
  malId: number,
  existing: EpisodeInfo[],
  force: boolean,
  linkMeta: Map<string, LinkMeta> = new Map(),
  fallbackArt: string | null = null,
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
          ...emptyEpisodeMetadata(fallbackArt),
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
        ...emptyEpisodeMetadata(fallbackArt),
        ...current,
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

function resolveHeuristic(linked: LinkedTorrent[], fallbackArt: string | null): EpisodeInfo[] {
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
      ...emptyEpisodeMetadata(fallbackArt),
    })
  }

  result.sort((a, b) => a.season - b.season || a.episode - b.episode)
  return result
}

// ─── Marcadores: AniSkip (abertura/créditos) ───────────────────────────────

const markerRefreshes = new BackgroundRefreshQueue(3, 5 * 60_000, (key, error) => {
  console.warn(`[episodes] background marker refresh failed (${key}):`, (error as Error).message)
})

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
  fetchMissing = false,
): Promise<void> {
  const targets = episodes.filter((ep) => ep.season > 0 && ep.episode > episodeOffset)
  if (targets.length === 0) return
  const keys = targets.map((ep) => `${malId}:${ep.episode - episodeOffset}`)
  const rows = await db.select({ key: metadata_cache.lookup_key, response: metadata_cache.response })
    .from(metadata_cache).where(and(eq(metadata_cache.source, 'aniskip'), inArray(metadata_cache.lookup_key, keys)))
  const cached = new Map(rows.map((row) => [row.key, row.response as aniskip.AniSkipMarkers & { _none?: boolean }]))
  for (const ep of targets) {
    try {
      const key = `${malId}:${ep.episode - episodeOffset}`
      const stored = cached.get(key)
      let sk: aniskip.AniSkipMarkers | null = stored && !stored._none ? stored : null
      if (!cached.has(key)) {
        if (fetchMissing) sk = await cachedAniskip(malId, ep.episode - episodeOffset)
        else markerRefreshes.schedule(key, () => cachedAniskip(malId, ep.episode - episodeOffset))
      }
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
    const rows = new Map<string, typeof torrent_episodes.$inferInsert>()
    for (const ep of episodes) {
      for (const t of ep.torrents) {
        rows.set(`${t.hash}:${ep.season}:${ep.episode}`, {
          content_id: contentId,
          torrent_hash: t.hash,
          season: ep.season,
          episode: ep.episode,
          file_index: t.file_index,
          inferred: t.inferred,
        })
      }
    }
    const values = [...rows.values()]
    for (let offset = 0; offset < values.length; offset += 500) {
      await db.insert(torrent_episodes).values(values.slice(offset, offset + 500))
        .onConflictDoUpdate({
          target: [
            torrent_episodes.content_id,
            torrent_episodes.torrent_hash,
            torrent_episodes.season,
            torrent_episodes.episode,
          ],
          set: {
            file_index: sql`excluded.file_index`,
            inferred: sql`excluded.inferred`,
            resolved_at: new Date(),
          },
        })
    }
  } catch (err) {
    console.warn(`[episodes] Failed to cache episodes for content ${contentId}:`, (err as Error).message)
  }
}
