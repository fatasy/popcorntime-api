import * as tmdb from '../enrichment/tmdb'
import * as mal from '../enrichment/myanimelist'
import * as tvmaze from '../enrichment/tvmaze'
import * as thetvdb from '../enrichment/thetvdb'
import { MAX_JIKAN_EPISODE_PAGES, PROVIDER_ORDER, STILL_IMAGE_SIZE, metaKey } from './episode-types'
import type {
  EpisodeImageMatch,
  EpisodeImageSource,
  EpisodeMetadataContext,
  EpisodeMetadataSource,
  TmdbEpisodeRecord,
} from './episode-types'
import type { EpisodeInfo } from './episodes'

/**
 * Provedores de metadado/arte POR EPISÓDIO e o mapeamento das numerações do
 * provedor para a listagem do conteúdo.
 *
 * Cada provedor devolve episódios "crus" (`ProviderEpisode`); o casamento com a
 * listagem (temporada/episódio, incluindo a numeração absoluta de anime) é feito
 * por `mapProviderEpisodes`. Nenhum still é inventado: sem casamento confiável o
 * episódio simplesmente não recebe arte.
 *
 * Falhas de rede/HTTP são LANÇADAS (o chamador marca cooldown e re-tenta);
 * ausência definitiva na fonte (404 / nenhum candidato aprovado pelos guardas de
 * nome) devolve lista vazia.
 */

// ─── Índice da listagem (mapeamento de temporada, incl. anime) ─────────────

export interface ListingTarget {
  key: string
  season: number
  episode: number
}

export interface ListingIndex {
  byKey: Set<string>
  /** Número absoluto (temporadas contíguas 1..n, reiniciando por temporada) → key. */
  cumulative: Map<number, string>
  /** Número do episódio na listagem → temporada dominante (numeração ABSOLUTA do MAL). */
  byEpisodeNumber: Map<number, number>
}

/** Só episódios reais: os baldes genéricos (temporada/episódio 0) não têm arte. */
export function metadataTargets(episodes: EpisodeInfo[]): ListingTarget[] {
  const out: ListingTarget[] = []
  for (const ep of episodes) {
    if (ep.season <= 0 || ep.episode <= 0) continue
    out.push({ key: metaKey(ep.season, ep.episode), season: ep.season, episode: ep.episode })
  }
  return out
}

export function buildListingIndex(targets: ListingTarget[]): ListingIndex {
  const byKey = new Set(targets.map((t) => t.key))
  const bySeason = new Map<number, number[]>()
  for (const t of targets) {
    const list = bySeason.get(t.season)
    if (list) list.push(t.episode)
    else bySeason.set(t.season, [t.episode])
  }
  for (const list of bySeason.values()) list.sort((a, b) => a - b)
  const seasons = Array.from(bySeason.keys()).sort((a, b) => a - b)

  // A listagem só aceita numeração ABSOLUTA quando ela começa na temporada 1,
  // tem temporadas consecutivas e episódios 1..n em cada uma. Fora disso (ex.:
  // catálogo com só a temporada 5), converter "episódio absoluto 5" para a
  // temporada 5 associaria a arte/​título de outro episódio — nesse caso vale
  // apenas o casamento DIRETO de (temporada, episódio).
  const contiguous =
    seasons.length > 0 &&
    seasons[0] === 1 &&
    seasons.every((s, i) => i === 0 || s === seasons[i - 1]! + 1) &&
    seasons.every((s) => {
      const list = bySeason.get(s)!
      return list.every((ep, j) => ep === j + 1)
    })

  const cumulative = new Map<number, string>()
  if (contiguous) {
    let offset = 0
    for (const s of seasons) {
      for (const ep of bySeason.get(s)!) {
        offset += 1
        cumulative.set(offset, metaKey(s, ep))
      }
    }
  }

  // Temporada dominante de um número de episódio — só faz sentido quando a
  // listagem numera do início (`contiguous`); ver comentário acima.
  const byEpisodeNumber = new Map<number, number>()
  const seasonsForNumber = new Map<number, Map<number, number>>()
  if (!contiguous) return { byKey, cumulative, byEpisodeNumber }
  for (const t of targets) {
    const counts = seasonsForNumber.get(t.episode)
    if (counts) counts.set(t.season, (counts.get(t.season) ?? 0) + 1)
    else seasonsForNumber.set(t.episode, new Map([[t.season, 1]]))
  }
  for (const [episode, counts] of seasonsForNumber) {
    let best = 0
    let season = 0
    for (const [s, n] of counts) {
      if (n > best) {
        best = n
        season = s
      }
    }
    if (season > 0) byEpisodeNumber.set(episode, season)
  }

  return { byKey, cumulative, byEpisodeNumber }
}

// ─── Vínculo por NOME (usado SÓ quando não há id externo) ───────────────────

/** Minúsculas, sem acento e sem pontuação — comparação exata de título. */
function normalizeTitle(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

function yearOfDate(value?: string | null): number | null {
  const match = value ? /^(\d{4})/.exec(value) : null
  return match ? Number(match[1]) : null
}

/** Títulos do conteúdo aceitos como candidatos (nunca para casar por id). */
function titleCandidates(content: EpisodeMetadataContext): string[] {
  const out: string[] = []
  for (const title of [content.title, content.original_title]) {
    if (title && normalizeTitle(title).length > 1) out.push(title)
  }
  return out
}

interface NameCandidate<T> {
  item: T
  name: string | null
  year: number | null
  language: string | null
}

/**
 * Escolhe UM candidato com guardas estritas. Só aceita resultado quando:
 *  (a) o nome normalizado é IDÊNTICO a um dos títulos do conteúdo,
 *  (b) o idioma passa no teste do provedor (anime exige japonês),
 *  (c) o ano de estreia bate com o do conteúdo (±1, quando ambos existem) e
 *  (d) sobra EXATAMENTE UM candidato.
 * Qualquer ambiguidade → null (melhor sem arte do que still de outro título).
 */
function pickExactNameMatch<T>(
  candidates: string[],
  results: NameCandidate<T>[],
  opts: { year: number | null; languageOk: (language: string | null) => boolean },
): T | null {
  const wanted = new Set(candidates.map(normalizeTitle))
  const matches = results.filter((r) => {
    const name = r.name ? normalizeTitle(r.name) : ''
    if (!name || !wanted.has(name)) return false
    if (!opts.languageOk(r.language)) return false
    if (opts.year != null && r.year != null && Math.abs(r.year - opts.year) > 1) return false
    return true
  })
  return matches.length === 1 ? matches[0]!.item : null
}

// ─── Episódio cru vindo de um provedor ─────────────────────────────────────

export interface ProviderEpisode {
  season: number
  episode: number
  source: EpisodeMetadataSource
  source_episode_id: string | null
  title: string | null
  title_original: string | null
  overview: string | null
  air_date: string | null
  runtime_sec: number | null
  score: number | null
  filler: boolean | null
  recap: boolean | null
  still_path: string | null
  still_url: string | null
  image_source: EpisodeImageSource | null
  image_match: EpisodeImageMatch | null
}

function providerBase(source: EpisodeMetadataSource): Omit<ProviderEpisode, 'season' | 'episode'> {
  return {
    source,
    source_episode_id: null,
    title: null,
    title_original: null,
    overview: null,
    air_date: null,
    runtime_sec: null,
    score: null,
    filler: null,
    recap: null,
    still_path: null,
    still_url: null,
    image_source: null,
    image_match: null,
  }
}

// ─── Provedor 1: TMDB ──────────────────────────────────────────────────────

function runTmdb(
  content: EpisodeMetadataContext,
  tmdbRecords: TmdbEpisodeRecord[] | undefined,
): ProviderEpisode[] | null {
  if (content.tmdb_id == null) return null
  if (!tmdbRecords || tmdbRecords.length === 0) {
    // `resolveEpisodes` já buscou o TMDB nesta requisição e não veio nada:
    // conta como FALHA do provedor (tenta de novo depois) em vez de gravar
    // um "não tem" definitivo.
    throw new Error('TMDB sem episódios nesta requisição')
  }
  return tmdbRecords.map((r) => {
    const still = tmdb.tmdbImage(r.still_path, STILL_IMAGE_SIZE)
    return {
      ...providerBase('tmdb'),
      season: r.season,
      episode: r.episode,
      source_episode_id: r.source_episode_id != null ? String(r.source_episode_id) : null,
      title: r.title,
      overview: r.overview,
      air_date: r.air_date,
      runtime_sec: r.runtime_sec,
      still_path: r.still_path,
      still_url: still,
      image_source: still ? 'tmdb' : null,
      image_match: still ? 'tmdb' : null,
    }
  })
}

// ─── Provedor 2: Jikan / MAL (anime) ───────────────────────────────────────

/**
 * Número do episódio no MAL: a `url` termina em `…/episode/{n}` (fonte
 * primária); `mal_id` é o fallback. Não confiamos só no `mal_id` porque o
 * significado do campo varia entre endpoints do Jikan.
 */
function jikanEpisodeNumber(ep: mal.JikanEpisode): number | null {
  const match = ep.url ? /\/(\d+)\/?$/.exec(ep.url) : null
  const fromUrl = match ? Number(match[1]) : NaN
  if (Number.isFinite(fromUrl) && fromUrl > 0) return fromUrl
  const fallback = Number(ep.mal_id)
  return Number.isFinite(fallback) && fallback > 0 ? fallback : null
}

async function runJikan(content: EpisodeMetadataContext): Promise<ProviderEpisode[] | null> {
  if (content.type !== 'anime' || content.mal_id == null) return null
  const list = await mal.getAnimeEpisodes(content.mal_id, MAX_JIKAN_EPISODE_PAGES)
  if (list.length === 0) {
    // Jikan 504 é frequente (MAL instável): lista vazia = FALHA, não
    // "anime sem episódios" — assim não persistimos ausência a partir de queda.
    throw new Error('Jikan sem lista de episódios (indisponível ou vazia)')
  }
  const out: ProviderEpisode[] = []
  for (const ep of list) {
    const number = jikanEpisodeNumber(ep)
    if (number == null) continue
    out.push({
      ...providerBase('jikan'),
      // O MAL numera de forma absoluta dentro de uma entrada; a temporada da
      // listagem é resolvida no mapeamento (abaixo).
      season: 1,
      episode: number,
      source_episode_id: String(number),
      title: ep.title ?? null,
      title_original: ep.title_japanese ?? ep.title_romanji ?? null,
      overview: null, // o endpoint de lista do Jikan não traz sinopse
      air_date: ep.aired ? ep.aired.slice(0, 10) : null,
      runtime_sec: null, // duração por episódio não existe no MAL
      score: typeof ep.score === 'number' ? ep.score : null,
      filler: ep.filler ?? null,
      recap: ep.recap ?? null,
      still_path: null, // MAL não expõe imagem por episódio
      still_url: null,
      image_source: null,
      image_match: null,
    })
  }
  return out
}

// ─── Provedor 3: TVMaze (imagem por episódio) ──────────────────────────────

function imdbIdOf(content: EpisodeMetadataContext): string | null {
  return content.imdb_id ?? content.external_imdb_id ?? null
}

async function runTvMaze(content: EpisodeMetadataContext): Promise<ProviderEpisode[]> {
  let showId: number | null = null
  let match: EpisodeImageMatch = 'imdb'

  const imdb = imdbIdOf(content)
  if (imdb) {
    const show = await tvmaze.lookupShowByImdb(imdb)
    if (show) showId = show.id
  }

  if (showId == null) {
    // Sem id externo: SÓ anime aceita vínculo por NOME, com guardas estritas.
    if (content.type !== 'anime') return []
    const query = content.title ?? content.original_title
    if (!query) return []
    const shows = await tvmaze.searchShows(query)
    const picked = pickExactNameMatch(
      titleCandidates(content),
      shows.map((s) => ({
        item: s,
        name: s.name ?? null,
        year: yearOfDate(s.premiered),
        language: s.language ?? null,
      })),
      {
        year: content.year,
        languageOk: (language) => (language ?? '').toLowerCase() === 'japanese',
      },
    )
    if (!picked) return []
    showId = picked.id
    match = 'title'
  }

  const episodes = await tvmaze.getShowEpisodes(showId)
  const out: ProviderEpisode[] = []
  for (const ep of episodes) {
    const season = ep.season ?? 0
    const number = ep.number ?? 0
    if (season <= 0 || number <= 0) continue
    const image = ep.image?.medium ?? ep.image?.original ?? null
    out.push({
      ...providerBase('tvmaze'),
      season,
      episode: number,
      source_episode_id: String(ep.id),
      title: ep.name ?? null,
      overview: tvmaze.stripHtml(ep.summary),
      air_date: ep.airdate ?? null,
      runtime_sec: typeof ep.runtime === 'number' ? ep.runtime * 60 : null,
      still_url: image,
      image_source: image ? 'tvmaze' : null,
      image_match: image ? match : null,
    })
  }
  return out
}

// ─── Provedor 4: TheTVDB (opcional, anime) ─────────────────────────────────

async function runTheTvdb(content: EpisodeMetadataContext): Promise<ProviderEpisode[] | null> {
  // Só anime e só com chave configurada (sem chave = provedor inativo).
  if (content.type !== 'anime' || !thetvdb.theTvdbConfigured()) return null

  let seriesId: number | null = null
  let match: EpisodeImageMatch = 'imdb'

  const imdb = imdbIdOf(content)
  if (imdb) seriesId = await thetvdb.findSeriesIdByImdb(imdb)

  if (seriesId == null) {
    const query = content.title ?? content.original_title
    if (!query) return []
    const results = await thetvdb.searchSeries(query)
    const picked = pickExactNameMatch(
      titleCandidates(content),
      results.map((r) => ({
        item: r,
        name: r.name ?? r.name_translated ?? r.title ?? null,
        year: r.year != null ? Number(r.year) : null,
        language: r.primary_language ?? null,
      })),
      {
        year: content.year,
        languageOk: (language) => (language ?? '').toLowerCase() === 'jpn',
      },
    )
    if (!picked) return []
    seriesId = thetvdb.tvdbNumericId(picked.tvdb_id) ?? thetvdb.tvdbNumericId(picked.id)
    match = 'title'
  }
  if (seriesId == null) return []

  const episodes = await thetvdb.getSeriesEpisodes(seriesId)
  const out: ProviderEpisode[] = []
  for (const ep of episodes) {
    const season = ep.seasonNumber ?? 0
    const number = ep.number ?? 0
    if (season <= 0 || number <= 0) continue
    const image = ep.image ?? null
    out.push({
      ...providerBase('thetvdb'),
      season,
      episode: number,
      source_episode_id: ep.id != null ? String(ep.id) : null,
      title: ep.name ?? null,
      overview: ep.overview ?? null,
      air_date: ep.aired ? ep.aired.slice(0, 10) : null,
      runtime_sec: typeof ep.runtime === 'number' ? ep.runtime * 60 : null,
      still_url: image,
      image_source: image ? 'thetvdb' : null,
      image_match: image ? match : null,
    })
  }
  return out
}

// ─── Mapeamento provedor → listagem ────────────────────────────────────────

function providerSeasonCounts(list: ProviderEpisode[]): Map<number, number> {
  const counts = new Map<number, number>()
  for (const ep of list) {
    if (ep.season <= 0 || ep.episode <= 0) continue
    counts.set(ep.season, (counts.get(ep.season) ?? 0) + 1)
  }
  return counts
}

/** Número absoluto segundo a própria estrutura de temporadas do provedor. */
function providerAbsolute(counts: Map<number, number>, season: number, episode: number): number {
  let absolute = episode
  for (const [s, c] of counts) if (s < season) absolute += c
  return absolute
}

/**
 * (temporada, episódio) do provedor → chave da listagem.
 *  1. casamento DIRETO — todos os tipos;
 *  2. anime: número absoluto → (temporada, episódio) da listagem (MAL/TVMaze
 *     numeram de formas diferentes da temporada derivada do torrent). Só quando
 *     a listagem é "contígua desde a temporada 1" (ver `buildListingIndex`);
 *  3. anime + Jikan: temporada dominante do número absoluto (mesma condição).
 * Séries (não-anime) NUNCA usam 2/3: sem casamento direto o episódio fica sem
 * still em vez de arriscar a arte de outro episódio.
 */
function resolveListingKey(
  ep: ProviderEpisode,
  index: ListingIndex,
  type: string,
  absolute: number,
): string | null {
  const direct = metaKey(ep.season, ep.episode)
  if (index.byKey.has(direct)) return direct
  if (type !== 'anime') return null

  const cumulative = index.cumulative.get(absolute)
  if (cumulative) return cumulative

  if (ep.source === 'jikan') {
    const season = index.byEpisodeNumber.get(ep.episode)
    if (season != null) {
      const key = metaKey(season, ep.episode)
      if (index.byKey.has(key)) return key
    }
  }
  return null
}

export function mapProviderEpisodes(
  list: ProviderEpisode[],
  index: ListingIndex,
  type: string,
): ProviderEpisode[] {
  const counts = providerSeasonCounts(list)
  const out: ProviderEpisode[] = []
  const seen = new Set<string>()
  for (const ep of list) {
    if (ep.season <= 0 || ep.episode <= 0) continue
    const key = resolveListingKey(ep, index, type, providerAbsolute(counts, ep.season, ep.episode))
    if (!key || seen.has(key)) continue
    seen.add(key)
    const [seasonStr, episodeStr] = key.split('|')
    out.push({ ...ep, season: Number(seasonStr), episode: Number(episodeStr) })
  }
  return out
}

export function applicableProviders(content: EpisodeMetadataContext): EpisodeMetadataSource[] {
  return PROVIDER_ORDER.filter((provider) => {
    if (provider === 'tmdb') return content.tmdb_id != null
    if (provider === 'jikan') return content.type === 'anime' && content.mal_id != null
    if (provider === 'thetvdb') return content.type === 'anime' && thetvdb.theTvdbConfigured()
    // tvmaze: vínculo por imdb; em anime, por nome com guardas (sem HTTP quando
    // não há como vincular).
    return true
  })
}

/** Falta still em algum episódio da listagem? (economiza chamadas de imagem) */
export function hasStillGap(
  acc: Map<string, { still_url: string | null }>,
  targets: ListingTarget[],
): boolean {
  for (const t of targets) {
    const entry = acc.get(t.key)
    if (!entry || entry.still_url == null) return true
  }
  return false
}

export async function runProvider(
  provider: EpisodeMetadataSource,
  content: EpisodeMetadataContext,
  tmdbRecords: TmdbEpisodeRecord[] | undefined,
): Promise<ProviderEpisode[] | null> {
  if (provider === 'tmdb') return runTmdb(content, tmdbRecords)
  if (provider === 'jikan') return runJikan(content)
  if (provider === 'tvmaze') return runTvMaze(content)
  return runTheTvdb(content)
}
