import { and, eq, gt, inArray, sql } from 'drizzle-orm'
import { db } from '../../db'
import { episode_metadata, metadata_cache } from '../../types'
import {
  EPISODE_METADATA_TTL_HOURS,
  IMAGE_CREDITS,
  IMAGE_RANK,
  MISS_CACHE_SOURCE,
  MISS_TTL_MINUTES,
  NONE_RANK,
  PARTIAL_TTL_HOURS,
  PROVIDER_ORDER,
  TEXT_RANK,
  metaKey,
} from './episode-types'
import type {
  EpisodeImageKind,
  EpisodeImageMatch,
  EpisodeImageSource,
  EpisodeMetadata,
  EpisodeMetadataContext,
  EpisodeMetadataRowSource,
  EpisodeMetadataSource,
  TmdbEpisodeRecord,
} from './episode-types'
import {
  applicableProviders,
  buildListingIndex,
  hasStillGap,
  mapProviderEpisodes,
  metadataTargets,
  runProvider,
} from './episode-providers'
import type { ListingTarget, ProviderEpisode } from './episode-providers'
import type { EpisodeInfo } from './episodes'

// Superfície pública do módulo (compatível com os imports já existentes em
// `episodes.ts` e com quem consumir o contrato de arte por episódio).
export { EPISODE_METADATA_TTL_HOURS }
export type {
  EpisodeImageKind,
  EpisodeImageMatch,
  EpisodeImageSource,
  EpisodeMetadata,
  EpisodeMetadataContext,
  EpisodeMetadataRowSource,
  EpisodeMetadataSource,
  TmdbEpisodeRecord,
} from './episode-types'

/**
 * Persistência, cache e ORQUESTRAÇÃO do metadado externo por episódio (tabela
 * `episode_metadata`, migration 007). Os provedores e o mapeamento de numeração
 * ficam em `episode-providers.ts`; o contrato compartilhado, em `episode-types.ts`.
 *
 * Precedência de texto: TMDB > Jikan/MAL > TVMaze > TheTVDB.
 * Precedência de imagem: TMDB > TVMaze > TheTVDB (o MAL não tem imagem por episódio).
 *
 * Cache (revisado):
 *  - a linha persistida vale `EPISODE_METADATA_TTL_HOURS` (24h);
 *  - a passada aos provedores só é pulada quando o cache cobre TODOS os episódios
 *    reais da listagem E cada linha tem `image_kind` resolvido (ausência explícita);
 *  - provedor que falha entra em cooldown de 30min e fica marcado como pendente
 *    (`partial:content:<id>`); enquanto todo pendente estiver em cooldown a
 *    passada é pulada (não martela API fora do ar) e, assim que um cooldown
 *    expira, a passada é refeita e as artes que faltavam são completadas;
 *  - passada sem pendências limpa os marcadores.
 *
 * Nada aqui altera o casamento torrent↔episódio nem a fonte de reprodução: o
 * metadado é anexado apenas aos episódios que a listagem já produzia.
 */

// ─── Acumulador (merge de provedores por episódio) ─────────────────────────

interface AccEntry {
  season: number
  episode: number
  text_rank: number
  source: EpisodeMetadataRowSource
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
  image_rank: number
  image_source: EpisodeImageSource | null
  image_match: EpisodeImageMatch | null
}

function emptyAcc(season: number, episode: number): AccEntry {
  return {
    season,
    episode,
    text_rank: NONE_RANK,
    source: 'none',
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
    image_rank: NONE_RANK,
    image_source: null,
    image_match: null,
  }
}

function accFromRow(row: EpisodeMetadata): AccEntry {
  return {
    season: row.season,
    episode: row.episode,
    text_rank: row.source === 'none' ? NONE_RANK : TEXT_RANK[row.source],
    source: row.source,
    source_episode_id: row.source_episode_id,
    title: row.title,
    title_original: row.title_original,
    overview: row.overview,
    air_date: row.air_date,
    runtime_sec: row.runtime_sec,
    score: row.score,
    filler: row.filler,
    recap: row.recap,
    still_path: row.still_path,
    still_url: row.still_url,
    image_rank: row.image_source ? IMAGE_RANK[row.image_source] : NONE_RANK,
    image_source: row.image_source,
    image_match: row.image_match,
  }
}

/** Merge de um episódio de provedor no acumulador (precedência por campo). */
function mergeProviderEpisode(acc: Map<string, AccEntry>, ep: ProviderEpisode): void {
  const key = metaKey(ep.season, ep.episode)
  const entry = acc.get(key) ?? emptyAcc(ep.season, ep.episode)

  const hasText =
    ep.title != null ||
    ep.overview != null ||
    ep.air_date != null ||
    ep.runtime_sec != null ||
    ep.score != null
  const textRank = TEXT_RANK[ep.source]
  const textWins = hasText && textRank < entry.text_rank
  if (textWins) {
    entry.text_rank = textRank
    entry.source = ep.source
    entry.source_episode_id = ep.source_episode_id ?? entry.source_episode_id
  }
  const pick = <T>(current: T | null, incoming: T | null): T | null =>
    textWins ? (incoming ?? current) : (current ?? incoming)

  entry.title = pick(entry.title, ep.title)
  entry.title_original = pick(entry.title_original, ep.title_original)
  entry.overview = pick(entry.overview, ep.overview)
  entry.air_date = pick(entry.air_date, ep.air_date)
  entry.runtime_sec = pick(entry.runtime_sec, ep.runtime_sec)
  entry.score = pick(entry.score, ep.score)
  entry.filler = pick(entry.filler, ep.filler)
  entry.recap = pick(entry.recap, ep.recap)

  if (ep.still_url != null) {
    const imageRank = ep.image_source ? IMAGE_RANK[ep.image_source] : NONE_RANK
    // Toma a arte quando não há nenhuma OU quando a nova tem precedência maior.
    if (entry.still_url == null || imageRank < entry.image_rank) {
      entry.still_path = ep.still_path
      entry.still_url = ep.still_url
      entry.image_rank = imageRank
      entry.image_source = ep.image_source
      entry.image_match = ep.image_match
    }
  }

  acc.set(key, entry)
}

function finalizeAcc(entry: AccEntry, fallbackArt: string | null): EpisodeMetadata {
  const still = entry.still_url
  const imageSource = still ? entry.image_source : null
  const credit = imageSource ? IMAGE_CREDITS[imageSource] : null
  return {
    season: entry.season,
    episode: entry.episode,
    source: entry.source,
    source_episode_id: entry.source_episode_id,
    title: entry.title,
    title_original: entry.title_original,
    overview: entry.overview,
    air_date: entry.air_date,
    runtime_sec: entry.runtime_sec,
    score: entry.score,
    filler: entry.filler,
    recap: entry.recap,
    still_path: still ? entry.still_path : null,
    still_url: still,
    thumbnail_url: still ?? fallbackArt,
    image_source: imageSource,
    image_kind: still ? 'still' : fallbackArt ? 'fallback' : 'none',
    image_match: still ? entry.image_match : null,
    image_credit: credit?.credit ?? null,
    image_credit_url: credit?.url ?? null,
    image_license: credit?.license ?? null,
  }
}

// ─── Leitura / escrita das linhas ──────────────────────────────────────────

/** Linhas persistidas e ainda dentro da janela de TTL. */
export async function loadEpisodeMetadata(contentId: number): Promise<Map<string, EpisodeMetadata>> {
  try {
    const cutoff = new Date(Date.now() - EPISODE_METADATA_TTL_HOURS * 60 * 60 * 1000)
    const rows = await db
      .select()
      .from(episode_metadata)
      .where(
        and(eq(episode_metadata.content_id, contentId), gt(episode_metadata.fetched_at, cutoff)),
      )
    return new Map(rows.map((r) => [metaKey(r.season, r.episode), fromRow(r)]))
  } catch (err) {
    // Tabela ausente (migração 007 ainda não aplicada) ou DB indisponível:
    // o endpoint continua respondendo, apenas sem o cache persistido.
    console.warn(`[episode-metadata] load failed for content ${contentId}:`, (err as Error).message)
    return new Map()
  }
}

/** Upsert em lote (chave content_id + season + episode). Best-effort. */
export async function persistEpisodeMetadata(
  contentId: number,
  rows: EpisodeMetadata[],
): Promise<void> {
  if (rows.length === 0) return
  const CHUNK = 200
  try {
    for (let i = 0; i < rows.length; i += CHUNK) {
      const chunk = rows.slice(i, i + CHUNK).map((r) => ({ content_id: contentId, ...toInsert(r) }))
      await db
        .insert(episode_metadata)
        .values(chunk)
        .onConflictDoUpdate({
          target: [episode_metadata.content_id, episode_metadata.season, episode_metadata.episode],
          set: {
            source: sql`excluded.source`,
            source_episode_id: sql`excluded.source_episode_id`,
            title: sql`excluded.title`,
            title_original: sql`excluded.title_original`,
            overview: sql`excluded.overview`,
            air_date: sql`excluded.air_date`,
            runtime_sec: sql`excluded.runtime_sec`,
            score: sql`excluded.score`,
            filler: sql`excluded.filler`,
            recap: sql`excluded.recap`,
            still_path: sql`excluded.still_path`,
            still_url: sql`excluded.still_url`,
            thumbnail_url: sql`excluded.thumbnail_url`,
            image_source: sql`excluded.image_source`,
            image_kind: sql`excluded.image_kind`,
            image_match: sql`excluded.image_match`,
            image_credit: sql`excluded.image_credit`,
            image_credit_url: sql`excluded.image_credit_url`,
            image_license: sql`excluded.image_license`,
            fetched_at: sql`now()`,
          },
        })
    }
  } catch (err) {
    console.warn(
      `[episode-metadata] persist failed for content ${contentId} (${rows.length} rows):`,
      (err as Error).message,
    )
  }
}

// ─── Estado do cache (miss por provedor + passada parcial) ─────────────────

const missKey = (contentId: number, provider: EpisodeMetadataSource) =>
  `miss:content:${contentId}:${provider}`
const partialKey = (contentId: number) => `partial:content:${contentId}`
/** Chave do formato anterior (`content:<id>`) — limpa ao fechar uma passada boa. */
const legacyMissKey = (contentId: number) => `content:${contentId}`

async function freshCacheKeys(keys: string[], ttlMinutes: number): Promise<Set<string>> {
  if (keys.length === 0) return new Set()
  try {
    const cutoff = new Date(Date.now() - ttlMinutes * 60 * 1000)
    const rows = await db
      .select({ lookup_key: metadata_cache.lookup_key })
      .from(metadata_cache)
      .where(
        and(
          eq(metadata_cache.source, MISS_CACHE_SOURCE),
          inArray(metadata_cache.lookup_key, keys),
          gt(metadata_cache.cached_at, cutoff),
        ),
      )
    return new Set(rows.map((r) => r.lookup_key))
  } catch {
    return new Set()
  }
}

/** Provedores em cooldown (falharam nos últimos 30min) — não são chamados. */
async function providersInCooldown(
  contentId: number,
  applicable: EpisodeMetadataSource[],
): Promise<Set<EpisodeMetadataSource>> {
  const keys = applicable.map((p) => missKey(contentId, p))
  const fresh = await freshCacheKeys(keys, MISS_TTL_MINUTES)
  return new Set(applicable.filter((p) => fresh.has(missKey(contentId, p))))
}

/**
 * Provedores que ficaram pendentes na última passada (falharam ou estavam em
 * cooldown). Enquanto o marcador existir, a passada é refeita assim que o
 * cooldown de algum pendente expirar — assim uma fonte que volta a funcionar
 * completa as artes em ≤30min, sem repetir o trabalho das fontes saudáveis.
 */
async function pendingProviders(contentId: number): Promise<EpisodeMetadataSource[]> {
  try {
    const cutoff = new Date(Date.now() - PARTIAL_TTL_HOURS * 60 * 60 * 1000)
    const rows = await db
      .select({ response: metadata_cache.response })
      .from(metadata_cache)
      .where(
        and(
          eq(metadata_cache.source, MISS_CACHE_SOURCE),
          eq(metadata_cache.lookup_key, partialKey(contentId)),
          gt(metadata_cache.cached_at, cutoff),
        ),
      )
      .limit(1)
    const stored = rows[0]?.response as { providers?: unknown } | undefined
    const list = Array.isArray(stored?.providers) ? stored.providers : []
    return list.filter((p): p is EpisodeMetadataSource =>
      PROVIDER_ORDER.includes(p as EpisodeMetadataSource),
    )
  } catch {
    return []
  }
}

async function markMiss(
  contentId: number,
  provider: EpisodeMetadataSource,
  reason: string,
): Promise<void> {
  try {
    const response = { _miss: true, provider, reason }
    await db
      .insert(metadata_cache)
      .values({ source: MISS_CACHE_SOURCE, lookup_key: missKey(contentId, provider), response })
      .onConflictDoUpdate({
        target: [metadata_cache.source, metadata_cache.lookup_key],
        set: { response, cached_at: sql`now()` },
      })
  } catch {
    /* cooldown é só proteção — nunca deve quebrar a resposta */
  }
}

/** Grava (ou limpa) o marcador da passada, conforme o que ficou pendente. */
async function recordPass(
  contentId: number,
  pending: EpisodeMetadataSource[],
): Promise<void> {
  const keys = [
    legacyMissKey(contentId),
    partialKey(contentId),
    ...PROVIDER_ORDER.map((p) => missKey(contentId, p)),
  ]
  try {
    if (pending.length === 0) {
      await db
        .delete(metadata_cache)
        .where(
          and(
            eq(metadata_cache.source, MISS_CACHE_SOURCE),
            inArray(metadata_cache.lookup_key, keys),
          ),
        )
      return
    }
    const response = { providers: pending }
    await db
      .insert(metadata_cache)
      .values({ source: MISS_CACHE_SOURCE, lookup_key: partialKey(contentId), response })
      .onConflictDoUpdate({
        target: [metadata_cache.source, metadata_cache.lookup_key],
        set: { response, cached_at: sql`now()` },
      })
  } catch (err) {
    console.warn(`[episode-metadata] pass bookkeeping failed for content ${contentId}:`, (err as Error).message)
  }
}

/** O cache persistido cobre TODOS os episódios reais da listagem? */
function cacheCovers(targets: ListingTarget[], cached: Map<string, EpisodeMetadata>): boolean {
  for (const t of targets) {
    const row = cached.get(t.key)
    // `image_kind` null = linha gravada antes do suporte a imagem: refaz a
    // passada para carimbar o estado explícito da arte.
    if (!row || row.image_kind == null) return false
  }
  return true
}

/**
 * Carrega (cache persistido) ou busca nos provedores o metadado externo do
 * conteúdo e devolve o mapa `season|episode` → metadado.
 *
 * `tmdbRecords` são os episódios que o TMDB já devolveu nesta requisição
 * (caminho TMDB de `resolveEpisodes`), evitando uma segunda chamada à API.
 */
export async function syncEpisodeMetadata(
  content: EpisodeMetadataContext,
  episodes: EpisodeInfo[],
  tmdbRecords?: TmdbEpisodeRecord[],
): Promise<Map<string, EpisodeMetadata>> {
  const targets = metadataTargets(episodes)
  const cached = await loadEpisodeMetadata(content.id)
  // Listagem só com baldes genéricos (temporada/episódio 0): nada a buscar.
  if (targets.length === 0) return cached

  const applicable = applicableProviders(content)
  const pending = await pendingProviders(content.id)
  const cooldown = await providersInCooldown(content.id, applicable)
  const covered = cacheCovers(targets, cached)

  // Coberto e sem pendências: reusa o cache persistido (zero chamadas de rede).
  if (covered && pending.length === 0) return cached

  // Coberto mas com pendências (uma fonte falhou/estava em cooldown): re-tenta
  // SÓ os pendentes — as fontes saudáveis não são chamadas de novo. Sem cache,
  // a passada é completa.
  const passProviders = covered ? applicable.filter((p) => pending.includes(p)) : applicable
  if (passProviders.length === 0) {
    // Pendências que já não são aplicáveis (ex.: chave do TheTVDB removida):
    // fecha a passada para não ficar re-tentando para sempre.
    await recordPass(content.id, [])
    return cached
  }
  // Todos os alvos da passada ainda em cooldown: espera expirar (≤30min) em vez
  // de martelar um provedor fora do ar.
  if (passProviders.every((p) => cooldown.has(p))) return cached

  const index = buildListingIndex(targets)
  const fallbackArt = content.backdrop_url ?? content.poster_url ?? null

  // Estado inicial = linhas em cache: provedores só PREENCHEM lacunas ou
  // substituem por uma fonte de precedência maior.
  const acc = new Map<string, AccEntry>()
  for (const [key, row] of cached) acc.set(key, accFromRow(row))

  const failed: EpisodeMetadataSource[] = []
  const deferred: EpisodeMetadataSource[] = []

  for (const provider of passProviders) {
    // Cooldown do provedor ainda fresco (falhou há <30min): não chama agora.
    if (cooldown.has(provider)) {
      deferred.push(provider)
      continue
    }
    // Provedores de imagem só entram se ainda falta still em algum episódio.
    if ((provider === 'tvmaze' || provider === 'thetvdb') && !hasStillGap(acc, targets)) {
      continue
    }
    try {
      const raw = await runProvider(provider, content, tmdbRecords)
      if (!raw || raw.length === 0) continue
      for (const ep of mapProviderEpisodes(raw, index, content.type)) {
        mergeProviderEpisode(acc, ep)
      }
    } catch (err) {
      failed.push(provider)
      console.warn(
        `[episode-metadata] provedor ${provider} falhou (content ${content.id}):`,
        (err as Error).message,
      )
      await markMiss(content.id, provider, (err as Error).message)
    }
  }

  const rows: EpisodeMetadata[] = targets.map((t) =>
    finalizeAcc(acc.get(t.key) ?? emptyAcc(t.season, t.episode), fallbackArt),
  )
  rows.sort((a, b) => a.season - b.season || a.episode - b.episode)

  await persistEpisodeMetadata(content.id, rows)
  await recordPass(content.id, Array.from(new Set([...failed, ...deferred])))

  // Devolve as linhas em memória: a resposta já sai correta mesmo que o upsert
  // tenha falhado (ex.: migração 007 pendente).
  return new Map(rows.map((r) => [metaKey(r.season, r.episode), r]))
}

/** Anexa o metadado externo aos episódios da listagem (não sobrescreve o que já veio do TMDB). */
export function attachEpisodeMetadata(
  episodes: EpisodeInfo[],
  meta: Map<string, EpisodeMetadata>,
): void {
  if (meta.size === 0) return
  for (const ep of episodes) {
    const m = meta.get(metaKey(ep.season, ep.episode))
    if (!m) continue
    if (ep.title == null) ep.title = m.title
    if (ep.air_date == null) ep.air_date = m.air_date
    ep.overview = m.overview
    ep.still_url = m.still_url
    ep.thumbnail_url = m.thumbnail_url
    ep.runtime_sec = m.runtime_sec
    ep.filler = m.filler
    ep.recap = m.recap
    ep.metadata_source = m.source === 'none' ? null : m.source
    // Contrato estável: `image_kind` sempre preenchido na resposta.
    ep.image_kind = m.image_kind ?? (m.still_url ? 'still' : m.thumbnail_url ? 'fallback' : 'none')
    ep.image_source = m.image_source
    ep.image_match = m.image_match
    ep.image_credit = m.image_credit
    ep.image_credit_url = m.image_credit_url
    ep.image_license = m.image_license
  }
}

/** Conveniência: sincroniza (persistindo) e anexa o metadado à listagem. */
export async function resolveEpisodeMetadata(
  content: EpisodeMetadataContext,
  episodes: EpisodeInfo[],
  tmdbRecords?: TmdbEpisodeRecord[],
): Promise<void> {
  try {
    const meta = await syncEpisodeMetadata(content, episodes, tmdbRecords)
    attachEpisodeMetadata(episodes, meta)
  } catch (err) {
    // Metadado externo é "nice to have": a listagem de episódios nunca falha por causa dele.
    console.warn(`[episode-metadata] attach failed for content ${content.id}:`, (err as Error).message)
  }
}

// ─── Conversão de/para linha do banco ──────────────────────────────────────

type EpisodeMetadataDbRow = typeof episode_metadata.$inferSelect

const ROW_SOURCES: readonly string[] = ['tmdb', 'jikan', 'tvmaze', 'thetvdb', 'none']
const IMAGE_SOURCES: readonly string[] = ['tmdb', 'tvmaze', 'thetvdb']
const IMAGE_KINDS: readonly string[] = ['still', 'fallback', 'none']
const IMAGE_MATCHES: readonly string[] = ['tmdb', 'imdb', 'thetvdb', 'title']

function asRowSource(value: string | null): EpisodeMetadataRowSource {
  return ROW_SOURCES.includes(value ?? '') ? (value as EpisodeMetadataRowSource) : 'none'
}

function asImageSource(value: string | null): EpisodeImageSource | null {
  return IMAGE_SOURCES.includes(value ?? '') ? (value as EpisodeImageSource) : null
}

function asImageKind(value: string | null): EpisodeImageKind | null {
  return IMAGE_KINDS.includes(value ?? '') ? (value as EpisodeImageKind) : null
}

function asImageMatch(value: string | null): EpisodeImageMatch | null {
  return IMAGE_MATCHES.includes(value ?? '') ? (value as EpisodeImageMatch) : null
}

function toInsert(r: EpisodeMetadata) {
  return {
    season: r.season,
    episode: r.episode,
    source: r.source,
    source_episode_id: r.source_episode_id,
    title: r.title,
    title_original: r.title_original,
    overview: r.overview,
    air_date: r.air_date,
    runtime_sec: r.runtime_sec,
    score: r.score != null ? String(r.score) : null,
    filler: r.filler,
    recap: r.recap,
    still_path: r.still_path,
    still_url: r.still_url,
    thumbnail_url: r.thumbnail_url,
    image_source: r.image_source,
    image_kind: r.image_kind,
    image_match: r.image_match,
    image_credit: r.image_credit,
    image_credit_url: r.image_credit_url,
    image_license: r.image_license,
  }
}

function fromRow(r: EpisodeMetadataDbRow): EpisodeMetadata {
  const score = r.score != null ? Number(r.score) : null
  return {
    season: r.season,
    episode: r.episode,
    source: asRowSource(r.source),
    source_episode_id: r.source_episode_id,
    title: r.title,
    title_original: r.title_original,
    overview: r.overview,
    air_date: r.air_date ?? null,
    runtime_sec: r.runtime_sec,
    score: score != null && Number.isFinite(score) ? score : null,
    filler: r.filler,
    recap: r.recap,
    still_path: r.still_path,
    still_url: r.still_url,
    thumbnail_url: r.thumbnail_url,
    image_source: asImageSource(r.image_source),
    image_kind: asImageKind(r.image_kind),
    image_match: asImageMatch(r.image_match),
    image_credit: r.image_credit,
    image_credit_url: r.image_credit_url,
    image_license: r.image_license,
  }
}
