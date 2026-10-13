import { and, asc, eq, inArray, isNull, or, sql } from 'drizzle-orm'
import { db } from '../../db'
import { anime_franchise_entries, contents, content_torrents, metadata_cache, torrents, type Content } from '../../types'
import { extractQuality } from '../../lib/parse'
import { getAiringAnime, getTrendingDaily, tmdbImage, type TmdbDiscoverItem } from '../enrichment/tmdb'
import { getTopAiringRanking, type JikanAnime } from '../enrichment/myanimelist'
import { BackgroundRefreshQueue, readExternalCatalog } from '../../lib/background-refresh'

/**
 * Faixa diária "em alta" — ranking EXTERNO completo, na ordem do provedor,
 * SINCRONIZADO com o catálogo interno.
 *
 * Fontes e títulos (o título viaja na resposta; o app não codifica):
 *  - filmes -> TMDB `/trending/movie/day`        -> "Em alta hoje"
 *  - séries -> TMDB `/trending/tv/day`           -> "Em alta hoje"
 *  - anime  -> Jikan `/top/anime?filter=airing`  -> "Animes em exibição"
 *    ATENÇÃO: o Jikan NÃO publica ranking diário de anime; é o ranking dos
 *    títulos atualmente em exibição — não chamar de tendência diária.
 *
 * Ciclo de atualização (cache de 1h, renovado pelo pipeline a cada 30min):
 *   1. o job renova listas vencidas, mesmo sem ninguém abrir o app;
 *   2. para CADA item, casa/cria o registro em `contents` pelo ID externo
 *      (+ tipo) e completa os metadados (título, ano, IDs, poster/backdrop,
 *      overview, rating);
 *   3. grava a lista COM os ids internos em `metadata_cache` e serve dali.
 * Enquanto o cache vale (1h) nenhuma chamada externa acontece. Pedidos com
 * cache vencido recebem a lista anterior e iniciam refresh em segundo plano.
 * Anime usa TMDB (animação japonesa com episódios nos últimos 30 dias) quando
 * Jikan falha, com fonte e IDs do TMDB explicitamente identificados. Se o provedor
 * falhar, serve o último ranking válido persistido (`cache.stale: true`) — com
 * os ids internos já resolvidos — ou `available: false` se nunca houve lista.
 *
 * A lista é devolvida INTEIRA e na ordem original: nada é removido por não ter
 * torrent ou vínculo prévio. `id` (interno) permite abrir `/catalog/:id`;
 * `primary` é o torrent primário atual (null = ainda sem fonte de reprodução —
 * o item continua na lista e o app mostra o estado "sem fonte"). A coleta de
 * torrents segue com o pipeline/coletor: NADA é coletado aqui.
 *
 * Sem migração (reusa `metadata_cache` JSONB) e sem scraping/browser.
 */

export type TrendingType = 'movie' | 'series' | 'anime'

/** Ordem sugerida de exibição para `?type=all`. */
export const TRENDING_TYPES: TrendingType[] = ['movie', 'series', 'anime']

const CACHE_SOURCE = 'trending'
/** Versão do payload em cache: mudou o DTO, o cache antigo é ignorado. */
const CACHE_VERSION = 3
/** The scheduled pipeline refreshes rankings once their one-hour TTL expires. */
export const TRENDING_REFRESH_HOURS = 1
/** Depois de uma falha, espera isso antes de bater no provedor de novo. */
const ERROR_TTL_MINUTES = 5
/** Teto de itens devolvidos por faixa (o app usa 10). */
export const TRENDING_MAX_LIMIT = 20
/** Tamanhos de imagem do TMDB (iguais aos usados pelo enriquecimento). */
const POSTER_SIZE = 'w500'
const BACKDROP_SIZE = 'w780'
/** `contents.title`/`original_title` são VARCHAR(512). */
const MAX_TITLE = 512

/**
 * Aviso fixo no contrato: item sem torrent continua na lista. O app abre
 * `/catalog/:id` quando houver `id` e sinaliza "sem fonte" quando `primary`
 * for null — nunca esconde o item.
 */
const LOCAL_LOOKUP_NOTICE =
  'Lista sincronizada com o catálogo interno: use `id` para abrir /catalog/:id. `primary: null` = ainda sem fonte de reprodução (o pipeline de torrents preenche depois) — não oculte o item, mostre o estado "sem fonte".'

// ─── DTO ───────────────────────────────────────────────────────────────────

/** Item do ranking externo, como vem do provedor (sem id interno/posição). */
export interface TrendingProviderItem {
  type: TrendingType
  source: 'tmdb' | 'jikan'
  /** ID no TMDB (movie/series). Null em anime. */
  tmdb_id: number | null
  /** ID no MAL (anime). Null em movie/series. */
  mal_id: number | null
  title: string | null
  original_title: string | null
  year: number | null
  /** Data de lançamento/estreia no provedor (ISO `YYYY-MM-DD`), quando houver. */
  release_date: string | null
  poster_url: string | null
  backdrop_url: string | null
  overview: string | null
  /** Nota do provedor (TMDB vote_average / MAL score). Não é ranking diário. */
  rating: number | null
  /** Página do item no provedor (atribuição / deep link). */
  source_url: string | null
}

/** Item do provedor já sincronizado com `contents` (é o que vai para o cache). */
export interface SyncedProviderItem extends TrendingProviderItem {
  /**
   * ID INTERNO em `contents` (abre `/catalog/:id`). `null` só quando a
   * sincronização falhou (ex.: DB indisponível) — o item permanece na lista.
   */
  id: number | null
}

/** Torrent primário atual — mesmo shape usado pelo `/catalog`. */
export interface TrendingPrimaryTorrent {
  content_id: number
  torrent_id: number
  title: string
  seeds: number | null
  leechers: number | null
  size_bytes: number | null
  magnet_link: string
  source: string
  quality: string
}

/** Item devolvido na API: ranking + metadados externos + id interno + torrent. */
export interface TrendingItem extends SyncedProviderItem {
  /** Posição no ranking do PROVEDOR (1 = primeiro). A ordem do array é a dele. */
  rank: number
  /** Torrent primário atual; `null` = sem fonte de reprodução (item mantido). */
  primary: TrendingPrimaryTorrent | null
}

/**
 * Contrato da faixa: `{ title, source, type, data }` + metadados auxiliares.
 * `data` é a lista do provedor (cortada só pelo `limit`), na ordem do ranking.
 */
export interface TrendingGroup {
  /** Título da faixa para exibir (ex.: "Em alta hoje"). */
  title: string
  source: 'tmdb' | 'jikan'
  type: TrendingType
  data: TrendingItem[]
  // ─── auxiliares (aditivos) ───
  /** Lista/endpoint do provedor que originou a ordem (auditoria). */
  source_list: string
  source_url: string
  /** Janela do ranking: `day` (TMDB diário) ou `airing` (anime em exibição). */
  ranking_window: 'day' | 'airing'
  /** false = o provedor não respondeu e não há lista persistida anterior. */
  available: boolean
  error: string | null
  /** Limitação do contrato (item sem torrent continua na lista). */
  notice: string
  limit: number
  /** Itens devolvidos (<= limit). */
  total: number
  /** Tamanho da lista do provedor ANTES do `limit` (permite "ver mais"). */
  provider_total: number
  cache: {
    hit: boolean
    stale: boolean
    age_seconds: number | null
    ttl_seconds: number
    /** Quando a lista persistida foi buscada no provedor (ISO). */
    fetched_at: string | null
  }
  generated_at: string
}

// ─── Config por faixa ──────────────────────────────────────────────────────

interface ProviderConfig {
  type: TrendingType
  title: string
  source: 'tmdb' | 'jikan'
  source_list: string
  source_url: string
  ranking_window: 'day' | 'airing'
  fetch: () => Promise<TrendingProviderItem[]>
}

function yearFrom(date?: string | null): number | null {
  const match = date ? /^(\d{4})/.exec(date) : null
  return match ? Number(match[1]) : null
}

function tmdbItem(media: 'movie' | 'tv', item: TmdbDiscoverItem): TrendingProviderItem {
  const date = item.release_date ?? item.first_air_date ?? null
  return {
    type: media === 'movie' ? 'movie' : 'series',
    source: 'tmdb',
    tmdb_id: item.id,
    mal_id: null,
    title: item.title ?? item.name ?? null,
    original_title: item.original_title ?? item.original_name ?? null,
    year: yearFrom(date),
    release_date: date,
    poster_url: tmdbImage(item.poster_path, POSTER_SIZE),
    backdrop_url: tmdbImage(item.backdrop_path, BACKDROP_SIZE),
    overview: item.overview ?? null,
    rating: typeof item.vote_average === 'number' ? item.vote_average : null,
    source_url: `https://www.themoviedb.org/${media === 'movie' ? 'movie' : 'tv'}/${item.id}`,
  }
}

function jikanItem(item: JikanAnime): TrendingProviderItem {
  return {
    type: 'anime',
    source: 'jikan',
    tmdb_id: null,
    mal_id: item.mal_id,
    title: item.title_english ?? item.title ?? null,
    original_title: item.title_japanese ?? item.title ?? null,
    year: item.year ?? item.aired?.prop?.from?.year ?? null,
    // A lista do Jikan não traz a data completa de estreia.
    release_date: null,
    poster_url: item.images?.jpg?.large_image_url ?? item.images?.jpg?.image_url ?? null,
    backdrop_url: null,
    overview: item.synopsis ?? null,
    rating: typeof item.score === 'number' ? item.score : null,
    source_url: `https://myanimelist.net/anime/${item.mal_id}`,
  }
}

function externalIdOf(item: TrendingProviderItem): number | null {
  return item.source === 'jikan' ? item.mal_id : item.tmdb_id
}

/** Both providers publish their own order; never label the fallback as a MAL ranking. */
export async function fetchAnimeRanking(): Promise<TrendingProviderItem[]> {
  try {
    const items = dedupe((await getTopAiringRanking(25, 5_000)).map(jikanItem))
    if (items.length) return items
  } catch (error) {
    console.warn('[trending] Jikan unavailable, trying TMDB:', (error as Error).message)
  }
  return dedupe((await getAiringAnime(2)).map((item) => ({ ...tmdbItem('tv', item), type: 'anime' })))
}

/** Remove IDs repetidos preservando a PRIMEIRA posição (ordem do provedor). */
function dedupe(items: TrendingProviderItem[]): TrendingProviderItem[] {
  const seen = new Set<string>()
  const out: TrendingProviderItem[] = []
  for (const item of items) {
    const id = externalIdOf(item)
    if (id == null || !Number.isFinite(id) || id <= 0) continue
    const key = `${item.source}:${item.type}:${id}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(item)
  }
  return out
}

const PROVIDERS: Record<TrendingType, ProviderConfig> = {
  movie: {
    type: 'movie',
    title: 'Em alta hoje',
    source: 'tmdb',
    source_list: 'trending/movie/day',
    source_url: 'https://www.themoviedb.org',
    ranking_window: 'day',
    fetch: async () => dedupe((await getTrendingDaily('movie', 2)).map((item) => tmdbItem('movie', item))),
  },
  series: {
    type: 'series',
    title: 'Em alta hoje',
    source: 'tmdb',
    source_list: 'trending/tv/day',
    source_url: 'https://www.themoviedb.org',
    ranking_window: 'day',
    fetch: async () => dedupe((await getTrendingDaily('tv', 2)).map((item) => tmdbItem('tv', item))),
  },
  anime: {
    type: 'anime',
    // Jikan/MAL não publica ranking diário: é o ranking dos animes EM EXIBIÇÃO.
    title: 'Animes em exibição',
    source: 'jikan',
    source_list: 'top/anime?filter=airing',
    source_url: 'https://myanimelist.net',
    ranking_window: 'airing',
    fetch: fetchAnimeRanking,
  },
}

const TYPE_ALIASES: Record<string, TrendingType> = {
  movie: 'movie',
  movies: 'movie',
  filme: 'movie',
  filmes: 'movie',
  series: 'series',
  serie: 'series',
  'séries': 'series',
  anime: 'anime',
  animes: 'anime',
}

/** Normaliza `?type=` (aceita singular/plural e pt-BR). */
export function normalizeTrendingType(value: string): TrendingType | null {
  return TYPE_ALIASES[value.trim().toLowerCase()] ?? null
}

// ─── Sincronização com o catálogo interno (`contents`) ─────────────────────

/** Coluna do ID externo correspondente ao tipo. */
function externalIdColumn(source: TrendingProviderItem['source']) {
  return source === 'jikan' ? contents.mal_id : contents.tmdb_id
}

/**
 * Ordem de preferência quando existe MAIS de um registro para o mesmo ID
 * externo (duplicata histórica de merge): o canônico é o que tem mais torrents
 * vinculados — mesma regra do `mergeByTmdbId` — e o menor id desempata.
 */
function canonicalFirst() {
  return [
    sql`(select count(*) from content_torrents ct where ct.content_id = ${contents.id}) desc`,
    asc(contents.id),
  ]
}

/** Todos os registros do tipo com esse ID externo (normalmente 1). */
async function findByExternalId(item: TrendingProviderItem, externalId: number): Promise<Content[]> {
  return db
    .select()
    .from(contents)
    .where(and(eq(contents.type, item.type), eq(externalIdColumn(item.source), externalId)))
    .orderBy(...canonicalFirst())
}

/**
 * Mesmo caminho de deduplicação usado pelo `jobs/discover`: tipo + título exato
 * + ano. Só considera registros AINDA SEM id externo (não "rouba" um registro já
 * ligado a outro título) e exige ano — sem ano o casamento por nome não é seguro.
 */
async function findByTitleYear(item: TrendingProviderItem): Promise<Content | null> {
  const title = item.title?.trim()
  if (!title || item.year == null) return null
  const rows = await db
    .select()
    .from(contents)
    .where(
      and(
        eq(contents.type, item.type),
        or(eq(contents.title, title.slice(0, MAX_TITLE)),
          item.original_title ? eq(contents.original_title, item.original_title.slice(0, MAX_TITLE)) : undefined),
        eq(contents.year, item.year),
        isNull(externalIdColumn(item.source)),
      ),
    )
    .orderBy(...canonicalFirst())
    .limit(1)
  return rows[0] ?? null
}

/**
 * Completa os metadados do registro com o que veio do provedor. Campos derivados
 * (título, ano, IDs, poster/backdrop, nota) são atualizados quando o valor novo
 * existe; `synopsis` é FILL-ONLY — não sobrescreve sinopse já gravada (protege a
 * tradução pt-BR do pipeline, mesma preocupação do `applyUpdate` do enriquecimento).
 */
async function updateFromProvider(
  row: Content,
  item: TrendingProviderItem,
  linkExternalId = false,
): Promise<void> {
  // `new Date()` (e não sql`now()`) porque `Partial<$inferInsert>` tipa
  // `updated_at` como Date — a diferença de valor é de milissegundos.
  const patch: Partial<typeof contents.$inferInsert> = { updated_at: new Date() }
  if (item.title) patch.title = item.title.slice(0, MAX_TITLE)
  if (item.original_title) patch.original_title = item.original_title.slice(0, MAX_TITLE)
  if (item.year != null) patch.year = item.year
  if (item.release_date) patch.release_date = item.release_date
  if (item.poster_url) patch.poster_url = item.poster_url
  if (item.backdrop_url) patch.backdrop_url = item.backdrop_url
  if (item.rating != null) patch.rating = String(item.rating)
  if (item.overview && row.synopsis == null) patch.synopsis = item.overview
  if (linkExternalId) {
    if (item.mal_id != null) patch.mal_id = item.mal_id
    if (item.tmdb_id != null) patch.tmdb_id = item.tmdb_id
  }
  await db.update(contents).set(patch).where(eq(contents.id, row.id))
}

/**
 * Cria o registro do item externo. Entra com `enriched_at = null` de propósito:
 * o pipeline de enriquecimento completa gêneros/elenco/sinopse pt-BR e o coletor
 * vincula torrents depois — aqui não coletamos nada.
 */
async function insertFromProvider(item: TrendingProviderItem): Promise<number | null> {
  const title = (item.title ?? item.original_title ?? '').trim()
  if (!title) return null // `contents.title` é NOT NULL
  const [row] = await db
    .insert(contents)
    .values({
      type: item.type,
      title: title.slice(0, MAX_TITLE),
      original_title: item.original_title ? item.original_title.slice(0, MAX_TITLE) : null,
      year: item.year,
      release_date: item.release_date,
      synopsis: item.overview,
      rating: item.rating != null ? String(item.rating) : null,
      poster_url: item.poster_url,
      backdrop_url: item.backdrop_url,
      tmdb_id: item.tmdb_id,
      mal_id: item.mal_id,
      enriched_at: null,
    })
    .returning({ id: contents.id })
  return row?.id ?? null
}

/**
 * Casa (ou cria) o registro interno de UM item externo, sem duplicar:
 *  1. ID externo + tipo  -> atualiza (e completa) o registro existente;
 *  2. tipo + título + ano (só registros sem id externo) -> vincula o ID;
 *  3. senão -> cria o registro.
 * Nunca lança: falha vira `id: null` e o item CONTINUA na lista.
 */
async function syncItem(item: TrendingProviderItem): Promise<number | null> {
  const externalId = externalIdOf(item)
  if (externalId == null) return null

  if (item.mal_id != null) {
    const [entry] = await db.select({ id: anime_franchise_entries.content_id })
      .from(anime_franchise_entries).where(eq(anime_franchise_entries.mal_id, item.mal_id)).limit(1)
    if (entry) return entry.id
  }
  const matches = await findByExternalId(item, externalId)
  if (matches.length > 0) {
    // Duplicatas do mesmo ID externo: atualiza todas (metadado consistente) e
    // devolve o canônico (mais torrents / menor id).
    for (const row of matches) await updateFromProvider(row, item)
    return matches[0]!.canonical_content_id ?? matches[0]!.id
  }

  const byTitle = await findByTitleYear(item)
  if (byTitle) {
    await updateFromProvider(byTitle, item, true)
    return byTitle.id
  }

  return insertFromProvider(item)
}

async function syncItemsToCatalog(items: TrendingProviderItem[]): Promise<SyncedProviderItem[]> {
  const out: SyncedProviderItem[] = []
  for (const item of items) {
    try {
      out.push({ ...item, id: await syncItem(item) })
    } catch (err) {
      console.warn(
        `[trending] sync falhou para "${item.title ?? '?'}" (${item.type}):`,
        (err as Error).message,
      )
      out.push({ ...item, id: null })
    }
  }
  return out
}

/** Torrent primário ATUAL dos itens (resolvido a cada request, nunca cacheado). */
async function attachPrimaries(ids: number[]): Promise<Map<number, TrendingPrimaryTorrent>> {
  if (ids.length === 0) return new Map()
  try {
    const primaries = await db
      .select({
        content_id: content_torrents.content_id,
        torrent_id: torrents.id,
        title: torrents.title,
        seeds: torrents.seeds,
        leechers: torrents.leechers,
        size_bytes: torrents.size_bytes,
        magnet_link: torrents.magnet_link,
        source: torrents.source,
      })
      .from(content_torrents)
      .innerJoin(torrents, eq(torrents.id, content_torrents.torrent_id))
      .where(and(eq(content_torrents.is_primary, true), inArray(content_torrents.content_id, ids)))
    return new Map(primaries.map((p) => [p.content_id, { ...p, quality: extractQuality(p.title) }]))
  } catch (err) {
    // Sem torrent primário a faixa continua servindo (primary: null).
    console.warn('[trending] lookup de primários falhou:', (err as Error).message)
    return new Map()
  }
}

// ─── Persistência/refresh (`metadata_cache` JSONB) ────────────────────────

interface CachePayload {
  v?: number
  items?: unknown[]
  _error?: boolean
  message?: string
  fetched_at?: string
}

const listKey = (type: TrendingType) => `list:${type}`
const errorKey = (type: TrendingType) => `error:${type}`

interface CacheRead {
  payload: CachePayload | null
  ageSeconds: number | null
  fetchedAt: string | null
}

async function readCache(key: string): Promise<CacheRead> {
  try {
    const rows = await db
      .select({ response: metadata_cache.response, cached_at: metadata_cache.cached_at })
      .from(metadata_cache)
      .where(and(eq(metadata_cache.source, CACHE_SOURCE), eq(metadata_cache.lookup_key, key)))
      .limit(1)
    const row = rows[0]
    if (!row) return { payload: null, ageSeconds: null, fetchedAt: null }
    const payload = (row.response ?? null) as CachePayload | null
    const ageSeconds = row.cached_at
      ? Math.max(0, Math.round((Date.now() - row.cached_at.getTime()) / 1000))
      : null
    const fetchedAt =
      typeof payload?.fetched_at === 'string'
        ? payload.fetched_at
        : row.cached_at
          ? row.cached_at.toISOString()
          : null
    return { payload, ageSeconds, fetchedAt }
  } catch (err) {
    // Tabela ausente/DB indisponível: segue sem cache, a faixa continua servindo.
    console.warn(`[trending] cache read failed (${key}):`, (err as Error).message)
    return { payload: null, ageSeconds: null, fetchedAt: null }
  }
}

async function writeCache(key: string, payload: CachePayload): Promise<void> {
  try {
    await db
      .insert(metadata_cache)
      .values({ source: CACHE_SOURCE, lookup_key: key, response: payload })
      .onConflictDoUpdate({
        target: [metadata_cache.source, metadata_cache.lookup_key],
        set: { response: payload, cached_at: sql`now()` },
      })
  } catch (err) {
    console.warn(`[trending] cache write failed (${key}):`, (err as Error).message)
  }
}

/** Um item de cache só é reaproveitado se ainda tem ID externo utilizável. */
function isUsableItem(value: unknown): value is SyncedProviderItem {
  if (value == null || typeof value !== 'object') return false
  const item = value as SyncedProviderItem
  if (item.source !== 'tmdb' && item.source !== 'jikan') return false
  if (!TRENDING_TYPES.includes(item.type)) return false
  if (item.id !== null && !Number.isFinite(item.id)) return false
  const id = externalIdOf(item)
  return typeof id === 'number' && Number.isFinite(id) && id > 0
}

/** Itens utilizáveis de um payload de cache (null quando não há lista válida). */
function cachedItems(payload: CachePayload | null): SyncedProviderItem[] | null {
  if (payload?.v !== CACHE_VERSION) return null
  if (!Array.isArray(payload.items)) return null
  const out = payload.items.filter(isUsableItem)
  return out.length ? out : null
}

interface ProviderListResult {
  items: SyncedProviderItem[]
  /** true = temos um ranking do provedor para exibir (mesmo que vencido). */
  available: boolean
  error: string | null
  cache: {
    hit: boolean
    stale: boolean
    age_seconds: number | null
    ttl_seconds: number
    fetched_at: string | null
  }
}

function cacheInfo(
  read: CacheRead,
  ttlSeconds: number,
  hit: boolean,
  stale: boolean,
): ProviderListResult['cache'] {
  return {
    hit,
    stale,
    age_seconds: read.ageSeconds,
    ttl_seconds: ttlSeconds,
    fetched_at: read.fetchedAt,
  }
}

/**
 * Refresh: busca no provedor E sincroniza `contents` ANTES de persistir o
 * ranking — assim o cache guarda os ids internos já resolvidos e o pedido
 * seguinte não precisa tocar em nada. Emprestado entre requests concorrentes
 * (uma única atualização por vez, por tipo) para não duplicar registros.
 */
const inflight = new Map<TrendingType, Promise<ProviderListResult>>()

async function refresh(
  cfg: ProviderConfig,
  previous: CacheRead,
  ttlSeconds: number,
): Promise<ProviderListResult> {
  const running = inflight.get(cfg.type)
  if (running) return running

  const task = (async (): Promise<ProviderListResult> => {
    try {
      const fetched = await cfg.fetch()
      if (fetched.length === 0) throw new Error('provedor devolveu ranking vazio')
      const items = await syncItemsToCatalog(fetched)
      const fetchedAt = new Date().toISOString()
      await writeCache(listKey(cfg.type), { v: CACHE_VERSION, items, fetched_at: fetchedAt })
      return {
        items,
        available: true,
        error: null,
        cache: { hit: false, stale: false, age_seconds: 0, ttl_seconds: ttlSeconds, fetched_at: fetchedAt },
      }
    } catch (err) {
      const message = (err as Error).message
      await writeCache(errorKey(cfg.type), { _error: true, message })
      const stale = cachedItems(previous.payload)
      return {
        items: stale ?? [],
        available: stale != null,
        error: message,
        cache: cacheInfo(previous, ttlSeconds, stale != null, true),
      }
    }
  })()

  inflight.set(cfg.type, task)
  try {
    return await task
  } finally {
    inflight.delete(cfg.type)
  }
}

/**
 * Lista persistida do provedor com REFRESH PREGUIÇOSO:
 *   1. lista com menos de `TRENDING_REFRESH_HOURS` -> serve a persistida (sem rede);
 *   2. provedor falhou nos últimos `ERROR_TTL_MINUTES` -> serve a persistida
 *      (stale) sem tentar de novo (evita martelar catálogo fora do ar);
 *   3. job aguarda renovação; GET serve stale e renova em segundo plano.
 * Nunca lança: falha vira `available:false` + `error` (ou ranking anterior stale).
 */
const refreshQueue = new BackgroundRefreshQueue(3, ERROR_TTL_MINUTES * 60_000)

async function resolveProviderList(cfg: ProviderConfig, waitForRefresh = false): Promise<ProviderListResult> {
  const ttlSeconds = TRENDING_REFRESH_HOURS * 3600
  const [good, failed] = await Promise.all([
    readCache(listKey(cfg.type)),
    readCache(errorKey(cfg.type)),
  ])
  const goodItems = cachedItems(good.payload)

  if (goodItems != null && good.ageSeconds != null && good.ageSeconds < ttlSeconds) {
    return {
      items: goodItems,
      available: true,
      error: null,
      cache: cacheInfo(good, ttlSeconds, true, false),
    }
  }

  if (!waitForRefresh && failed.ageSeconds != null && failed.ageSeconds < ERROR_TTL_MINUTES * 60) {
    return {
      items: goodItems ?? [],
      available: goodItems != null,
      error: failed.payload?.message ?? 'provedor indisponível',
      cache: cacheInfo(good, ttlSeconds, goodItems != null, true),
    }
  }

  const saved: ProviderListResult = {
    items: goodItems ?? [], available: goodItems != null, error: null,
    cache: cacheInfo(good, ttlSeconds, goodItems != null, true),
  }
  const result = await readExternalCatalog({
    key: cfg.type, queue: refreshQueue, ttlMs: ttlSeconds * 1000,
    read: async () => goodItems == null ? null : {
      value: saved, cachedAt: new Date(Date.now() - (good.ageSeconds ?? ttlSeconds) * 1000),
    },
    refresh: () => refresh(cfg, good, ttlSeconds),
    force: waitForRefresh, coldWaitMs: 1200,
  })
  return result ?? { ...saved, error: 'ranking em atualização' }
}

// ─── Montagem da faixa ─────────────────────────────────────────────────────

/**
 * Faixa no contrato `{ title, source, type, data }`: a lista do provedor vai
 * INTEIRA (cortada só pelo `limit`), na ordem original, com o id interno do
 * registro sincronizado e o torrent primário atual (quando existir).
 */
export async function getTrendingGroup(type: TrendingType, limit = 10, waitForRefresh = false): Promise<TrendingGroup> {
  const cfg = PROVIDERS[type]
  const cappedLimit = Math.min(TRENDING_MAX_LIMIT, Math.max(1, Math.trunc(limit)))
  const provider = await resolveProviderList(cfg, waitForRefresh)
  const ranking = provider.items.slice(0, cappedLimit)
  const source = provider.items[0]?.source ?? cfg.source
  const animeFallback = type === 'anime' && source === 'tmdb'

  const contentIds = ranking.flatMap((item) => (item.id != null ? [item.id] : []))
  const primaries = await attachPrimaries(contentIds)

  return {
    title: cfg.title,
    source,
    type,
    data: ranking.map((item, index) => ({
      ...item,
      rank: index + 1,
      primary: item.id != null ? (primaries.get(item.id) ?? null) : null,
    })),
    source_list: animeFallback ? 'discover/tv?with_genres=16&with_original_language=ja&air_date=last30days&sort_by=popularity.desc' : cfg.source_list,
    source_url: source === 'tmdb' ? 'https://www.themoviedb.org' : cfg.source_url,
    ranking_window: cfg.ranking_window,
    available: provider.available,
    error: provider.error,
    notice: LOCAL_LOOKUP_NOTICE,
    limit: cappedLimit,
    total: ranking.length,
    provider_total: provider.items.length,
    cache: provider.cache,
    generated_at: new Date().toISOString(),
  }
}

/** Called by the existing ingestion schedule, before slower torrent maintenance. */
export async function refreshTrendingCatalog(): Promise<void> {
  const results = await Promise.all(TRENDING_TYPES.map((type) => getTrendingGroup(type, 20, true)))
  for (const result of results) {
    console.log(`[trending] ${result.type}: ${result.provider_total} items, source=${result.source}, fetched=${result.cache.fetched_at}, stale=${result.cache.stale}`)
    if (result.error) console.warn(`[trending] ${result.type}: ${result.error}`)
  }
  if (results.some((result) => !result.available)) throw new Error('One or more catalog rankings are unavailable')
}
