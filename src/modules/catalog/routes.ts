import { Elysia, t } from 'elysia'
import {
  and,
  asc,
  count,
  desc,
  eq,
  getTableColumns,
  gte,
  ilike,
  inArray,
  isNotNull,
  isNull,
  lt,
  or,
  sql,
  type SQL,
} from 'drizzle-orm'
import { db } from '../../db'
import { anime_franchise_entries, contents, content_torrents, torrents } from '../../types'
import { resolveEpisodes, type EpisodeInfo } from '../torrent/episodes'
import { classifySeasonCoverage, type SeasonCoverage } from '../torrent/season-coverage'
import { hasPortugueseAudio } from '../../lib/parse'
import { extractQualityLabel } from '../torrent/quality'
import { TRENDING_MAX_LIMIT, TRENDING_TYPES, getTrendingGroup, normalizeTrendingType } from './trending'
import { jwtPlugin } from '../auth/jwt'
import { resolveAuth } from '../auth/guard'
import { refreshCatalogContent, type CatalogRefreshResult, type RefreshScope } from './refresh'
import { resolveCanonicalContentId } from '../anime/franchise'
import { fillGaps } from '../collection/fill-gaps'
import { importExternalCatalog, searchExternalCatalog } from './external'
import { countHttpEpisodeSources, refreshAnimeHttpSources } from '../streams/service'
import { CHINESE_FANTASY_RANK_SQL, CURRENT_RANK_SQL, DORAMA_RANK_SQL } from './popularity'
import { chineseFantasyFilterGenres } from './chinese-fantasy'
import { isDoramaFilter } from './dorama'

// Evita que dois cliques (ou dois dispositivos) disparem o mesmo crawler em
// paralelo para um título. Todos aguardam a execução já em curso.
const activeRefreshes = new Map<number, Promise<CatalogRefreshResult>>()

interface EpisodeSourceRefreshResult {
  contentId: number
  season: number
  episode: number
  sourcesFound: number
  sourcesAdded: number
  sourceWarnings: string[]
  refreshedAt: string
}

const activeEpisodeRefreshes = new Map<string, Promise<EpisodeSourceRefreshResult>>()

function refreshOnce(id: number, scope: RefreshScope): Promise<CatalogRefreshResult> {
  const running = activeRefreshes.get(id)
  if (running) return running
  const task = refreshCatalogContent(id, scope).finally(() => activeRefreshes.delete(id))
  activeRefreshes.set(id, task)
  return task
}

async function countEpisodeSources(contentId: number, season: number, episode: number): Promise<number> {
  const [row] = await db
    .select({ value: count() })
    .from(content_torrents)
    .where(
      and(
        eq(content_torrents.content_id, contentId),
        eq(content_torrents.season, season),
        or(eq(content_torrents.episode, episode), isNull(content_torrents.episode)),
      ),
    )
  return (row?.value ?? 0) + await countHttpEpisodeSources(contentId, season, episode)
}

function refreshEpisodeSourcesOnce(
  contentId: number,
  season: number,
  episode: number,
): Promise<EpisodeSourceRefreshResult> {
  const key = `${contentId}:${season}:${episode}`
  const running = activeEpisodeRefreshes.get(key)
  if (running) return running

  const task = (async () => {
    const before = await countEpisodeSources(contentId, season, episode)
    const http = await refreshAnimeHttpSources(contentId, { season, episode })
    await fillGaps(1, {
      contentId,
      maxEpisodesPerContent: 1,
      targetEpisode: { season, episode },
    })
    const after = await countEpisodeSources(contentId, season, episode)
    return {
      contentId,
      season,
      episode,
      sourcesFound: after,
      sourcesAdded: Math.max(0, after - before),
      sourceWarnings: http.sourceWarnings,
      refreshedAt: new Date().toISOString(),
    }
  })().finally(() => activeEpisodeRefreshes.delete(key))

  activeEpisodeRefreshes.set(key, task)
  return task
}

// Whitelisted sortable columns (prevents arbitrary-column ordering).
const SORT_COLUMNS = {
  created_at: contents.created_at,
  updated_at: contents.updated_at,
  release_date: contents.release_date,
  year: contents.year,
  rating: contents.rating,
  title: contents.title,
} as const
type SortKey = keyof typeof SORT_COLUMNS

interface FilterInput {
  type?: string
  genre?: string
  year?: number
  search?: string
  enriched?: boolean
  // Lookup EXATO por ID externo — usado no clique de um item do /trending
  // (que lista o catálogo externo sem filtrar). O app manda `type` junto:
  // movie|series + tmdb_id, ou anime + mal_id.
  tmdb_id?: number
  mal_id?: number
  // ISO timestamps: filter by when the content was added to the catalog.
  created_after?: string
  created_before?: string
  // Calendar dates: filter by the real premiere/release date.
  released_after?: string
  released_before?: string
}

/** Parses an ISO date string; returns null if absent or invalid (so a bad query param is ignored, not fatal). */
function parseDate(s?: string): Date | null {
  if (!s) return null
  const d = new Date(s)
  return Number.isNaN(d.getTime()) ? null : d
}

function parseDateOnly(value?: string): string | null {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null
  const date = new Date(`${value}T00:00:00Z`)
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value
    ? value
    : null
}

/**
 * Inteiro positivo vindo da query. Ausente/inválido -> null (o parâmetro é
 * simplesmente ignorado, mesma filosofia de `parseDate`: um query param ruim
 * não pode derrubar a listagem).
 */
function positiveInt(value?: number | null): number | null {
  if (value == null) return null
  if (!Number.isFinite(value)) return null
  const n = Math.trunc(value)
  return n > 0 ? n : null
}

// Os gêneros são gravados em IDIOMAS diferentes por fonte: TMDB (filmes/séries) em
// pt-BR ("Ação", "Comédia"), Jikan/MAL (animes) e OMDb em inglês ("Action", "Comedy").
// Um filtro ?genre=Ação precisa casar AMBOS, senão `type=anime&genre=Ação` retorna 0.
// Mapeia cada gênero pt-BR para os sinônimos equivalentes (inclui o próprio).
const GENRE_ALIASES: Record<string, string[]> = {
  Ação: ['Ação', 'Action'],
  Aventura: ['Aventura', 'Adventure'],
  Comédia: ['Comédia', 'Comedy'],
  Drama: ['Drama'],
  Animação: ['Animação', 'Animation'],
  Família: ['Família', 'Family'],
  Fantasia: ['Fantasia', 'Fantasy'],
  Terror: ['Terror', 'Horror'],
  Romance: ['Romance'],
  'Ficção científica': ['Ficção científica', 'Sci-Fi', 'Sci-Fi & Fantasy', 'Science Fiction'],
  Mistério: ['Mistério', 'Mystery'],
  Suspense: ['Suspense', 'Thriller'],
  Crime: ['Crime'],
  Documentário: ['Documentário', 'Documentary'],
  Guerra: ['Guerra', 'War'],
}

/** Condição "o conteúdo tem o gênero pedido (ou um sinônimo em outro idioma)". */
function genreFilter(genre: string): SQL {
  if (isDoramaFilter(genre)) return sql`${contents.type} = 'series' AND 'Dorama' = ANY(${contents.genres})`
  const aliases = chineseFantasyFilterGenres(genre) ?? GENRE_ALIASES[genre] ?? [genre]
  const ors = aliases.map((g) => sql`${g} = ANY(${contents.genres})`)
  return ors.length === 1 ? ors[0]! : or(...ors)!
}

function buildFilters(input: FilterInput): SQL[] {
  // Aliases preservam URLs/favoritos antigos, mas nunca aparecem como outro
  // card no catálogo.
  const conds: SQL[] = [isNull(contents.canonical_content_id)]
  if (input.type) conds.push(eq(contents.type, input.type))
  if (input.year != null) conds.push(eq(contents.year, input.year))
  // Lookup exato por ID externo (clique do /trending). Note que os IDs do TMDB
  // de movie e tv são espaços distintos — por isso o app envia `type` junto.
  const tmdbId = positiveInt(input.tmdb_id)
  if (tmdbId != null) conds.push(eq(contents.tmdb_id, tmdbId))
  const malId = positiveInt(input.mal_id)
  if (malId != null) conds.push(eq(contents.mal_id, malId))
  if (input.genre) conds.push(genreFilter(input.genre))
  if (input.search) conds.push(ilike(contents.title, `%${input.search}%`))
  if (input.enriched) conds.push(isNotNull(contents.enriched_at))
  const after = parseDate(input.created_after)
  if (after) conds.push(gte(contents.created_at, after))
  const before = parseDate(input.created_before)
  if (before) conds.push(lt(contents.created_at, before))
  const releasedAfter = parseDateOnly(input.released_after)
  if (releasedAfter) conds.push(gte(contents.release_date, releasedAfter))
  const releasedBefore = parseDateOnly(input.released_before)
  if (releasedBefore) conds.push(lt(contents.release_date, releasedBefore))
  return conds
}

/**
 * Ordem das fontes exibidas: áudio PT-BR primeiro, depois a primária curada e
 * por fim mais seeds. Vale p/ ficha (temporadas) e para a lista por episódio.
 */
function sortSourcesPtbrFirst<
  T extends { title?: string | null; is_primary?: boolean | null; seeds?: number | null },
>(list: T[]): T[] {
  return list.sort((a, b) => {
    const pa = hasPortugueseAudio(a.title ?? '') ? 1 : 0
    const pb = hasPortugueseAudio(b.title ?? '') ? 1 : 0
    if (pa !== pb) return pb - pa
    if (!!a.is_primary !== !!b.is_primary) return a.is_primary ? -1 : 1
    return (b.seeds ?? 0) - (a.seeds ?? 0)
  })
}

// ─── Popularity sort (by primary torrent seeds) ─────────────────────────
const POPULARITY_SQL = sql<number>`
  COALESCE(
    (SELECT t.seeds FROM content_torrents ct
     JOIN torrents t ON t.id = ct.torrent_id
     WHERE ct.content_id = ${contents.id} AND ct.is_primary = true
     LIMIT 1),
    0
  )
`

interface ListOptions {
  filters: SQL[]
  genre?: string
  sort: SortKey | 'popular'
  order: 'asc' | 'desc'
  page: number
  limit: number
}

async function listContents(opts: ListOptions) {
  const where = opts.filters.length ? and(...opts.filters) : undefined
  const offset = (opts.page - 1) * opts.limit

  // Current external rankings first; primary torrent seeds remain the fallback.
  const isPopular = opts.sort === 'popular'
  const ranking = isDoramaFilter(opts.genre ?? '') ? DORAMA_RANK_SQL
    : chineseFantasyFilterGenres(opts.genre ?? '') ? CHINESE_FANTASY_RANK_SQL : CURRENT_RANK_SQL
  const sortCol = isPopular ? POPULARITY_SQL : (SORT_COLUMNS[opts.sort as SortKey] ?? contents.created_at)
  const orderBy = opts.order === 'asc' ? asc(sortCol) : desc(sortCol)

  const rows = await db
    .select()
    .from(contents)
    .where(where)
    .orderBy(...(isPopular ? [opts.order === 'asc' ? asc(ranking) : desc(ranking)] : []), orderBy, desc(contents.id))
    .limit(opts.limit)
    .offset(offset)

  const totalRes = await db.select({ value: count() }).from(contents).where(where)
  const total = totalRes[0]?.value ?? 0

  // Attach the primary torrent for each returned content.
  const ids = rows.map((r) => r.id)
  const primaries = ids.length
    ? await db
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
    : []
  const primaryByContent = new Map(primaries.map((p) => [p.content_id, p]))

  const data = rows.map((row) => ({ ...row, primary: primaryByContent.get(row.id) ? { ...primaryByContent.get(row.id), quality: extractQualityLabel(primaryByContent.get(row.id)!.title) } : null }))
  return { data, total }
}

function pagination(query: { page?: number; limit?: number }) {
  const page = Math.max(1, query.page ?? 1)
  const limit = Math.min(100, Math.max(1, query.limit ?? 20))
  return { page, limit }
}

export const catalogRoutes = new Elysia()
  .use(jwtPlugin)
  // GET /catalog — filtered, sorted, paginated catalog
  .get(
    '/catalog',
    async ({ query }) => {
      const { page, limit } = pagination(query)
      const filters = buildFilters({
        type: query.type,
        genre: query.genre,
        year: query.year,
        search: query.q,
        enriched: query.enriched === 'true' || query.enriched === '1',
        created_after: query.created_after,
        created_before: query.created_before,
        released_after: query.released_after,
        released_before: query.released_before,
        tmdb_id: query.tmdb_id,
        mal_id: query.mal_id,
      })
      const isValidSort = query.sort === 'popular' || (query.sort != null && query.sort in SORT_COLUMNS)
      const sort = isValidSort ? (query.sort as SortKey | 'popular') : 'created_at'
      const order = query.order === 'asc' ? 'asc' : 'desc'
      const { data, total } = await listContents({ filters, genre: query.genre, sort, order, page, limit })
      return { data, meta: { page, limit, total } }
    },
    {
      query: t.Object({
        type: t.Optional(t.String()),
        genre: t.Optional(t.String()),
        year: t.Optional(t.Numeric()),
        // Lookup exato por ID EXTERNO (clique de item do /trending): envie
        // `type` junto — movie|series + tmdb_id, ou anime + mal_id.
        tmdb_id: t.Optional(t.Numeric()),
        mal_id: t.Optional(t.Numeric()),
        q: t.Optional(t.String()),
        sort: t.Optional(t.String()),
        order: t.Optional(t.String()),
        enriched: t.Optional(t.String()),
        created_after: t.Optional(t.String()),
        created_before: t.Optional(t.String()),
        released_after: t.Optional(t.String()),
        released_before: t.Optional(t.String()),
        page: t.Optional(t.Numeric()),
        limit: t.Optional(t.Numeric()),
      }),
      detail: { summary: 'List catalog contents', tags: ['catalog'] },
    },
  )
  // GET /catalog/:id — full content with all linked torrents
  .get(
    '/catalog/:id',
    async ({ params, set }) => {
      const requestedId = Number(params.id)
      if (!Number.isInteger(requestedId)) {
        set.status = 400
        return { error: 'Invalid id' }
      }
      const id = await resolveCanonicalContentId(requestedId)
      const rows = await db.select().from(contents).where(eq(contents.id, id)).limit(1)
      const content = rows[0]
      if (!content) {
        set.status = 404
        return { error: 'Content not found' }
      }
      const linked = await db
        .select({
          ...getTableColumns(torrents),
          is_primary: content_torrents.is_primary,
          season: content_torrents.season,
          episode: content_torrents.episode,
        })
        .from(content_torrents)
        .innerJoin(torrents, eq(torrents.id, content_torrents.torrent_id))
        .where(eq(content_torrents.content_id, id))
        .orderBy(desc(content_torrents.is_primary), desc(torrents.seeds))

      // Add quality to each linked torrent. Ordem das fontes na ficha: áudio
      // PT-BR primeiro, depois a primária curada, depois mais seeds.
      const linkedWithQuality = sortSourcesPtbrFirst(
        linked.map((t: any) => ({
          ...t,
          quality: extractQualityLabel(t.title),
          ptbr_audio: hasPortugueseAudio(t.title ?? ''),
        })),
      )

      // For series and anime, group torrents by season using coverage classification
      if (content.type === 'series' || content.type === 'anime') {
        const franchise = content.type === 'anime'
          ? await db
              .select()
              .from(anime_franchise_entries)
              .where(eq(anime_franchise_entries.content_id, id))
              .orderBy(
                asc(anime_franchise_entries.season_number),
                asc(anime_franchise_entries.part_number),
              )
          : []
        // Classify each torrent's season coverage
        const coverageMap = new Map<number, SeasonCoverage>()
        if (franchise.length === 0) {
          for (const t of linked) {
            try {
              const coverage = await classifySeasonCoverage(t.title, content.tmdb_id)
              coverageMap.set(t.id, coverage)
            } catch {
              coverageMap.set(t.id, { type: 'unknown', seasons: [], confidence: 'heuristic' })
            }
          }
        }

        const bySeason = new Map<number, typeof linkedWithQuality>()
        const unknownSeason: typeof linkedWithQuality = []

        for (const t of linkedWithQuality) {
          const coverage = coverageMap.get(t.id)

          if (coverage && coverage.seasons.length > 1) {
            // Multi-season torrent: add to all covered seasons
            for (const s of coverage.seasons) {
              if (!bySeason.has(s)) bySeason.set(s, [])
              bySeason.get(s)!.push(t)
            }
          } else if (t.season != null) {
            // Single season from content_torrents
            if (!bySeason.has(t.season)) bySeason.set(t.season, [])
            bySeason.get(t.season)!.push(t)
          } else {
            unknownSeason.push(t)
          }
        }

        // Pack "COMPLETO" (sem temporada no vínculo, mas com `file_list`) cobre
        // todas as temporadas da franquia → entra em cada grupo de temporada em
        // vez de virar uma "Temporada 0" fantasma.
        const completePacks = unknownSeason.filter(
          (t: any) => Array.isArray(t.file_list) && t.file_list.length > 0,
        )
        if (completePacks.length > 0) {
          for (const pack of completePacks) {
            const at = unknownSeason.indexOf(pack)
            if (at >= 0) unknownSeason.splice(at, 1)
          }
          const seasonNumbers = franchise.length > 0
            ? [...new Set(franchise.map((entry) => entry.season_number))].sort((a, b) => a - b)
            : [...bySeason.keys()].sort((a, b) => a - b)
          for (const season of seasonNumbers) {
            if (!bySeason.has(season)) bySeason.set(season, [])
            for (const pack of completePacks) bySeason.get(season)!.push(pack as any)
          }
        }
        for (const list of bySeason.values()) sortSourcesPtbrFirst(list)

        const seasons = Array.from(bySeason.entries())
          .sort(([a], [b]) => a - b)
          .map(([season, torrents]) => ({
            season,
            torrent_count: torrents.length,
            torrents,
          }))
        // If there are torrents without season info, put them in season 0
        if (unknownSeason.length > 0) {
          seasons.push({ season: 0, torrent_count: unknownSeason.length, torrents: unknownSeason })
        }
        const franchiseSeasonCount = franchise.length > 0
          ? Math.max(...franchise.map((entry) => entry.season_number))
          : 0
        return {
          ...content,
          seasons,
          season_count: franchiseSeasonCount || bySeason.size,
          catalog_seasons: franchise,
        }
      }

      return { ...content, torrents: linkedWithQuality }
    },
    {
      params: t.Object({ id: t.String() }),
      detail: { summary: 'Get a content with its torrents', tags: ['catalog'] },
    },
  )
  // GET /catalog/:id/episodes — structured episode list for series
  .get(
    '/catalog/:id/episodes',
    async ({ params, set }) => {
      const requestedId = Number(params.id)
      if (!Number.isInteger(requestedId)) {
        set.status = 400
        return { error: 'Invalid id' }
      }

      // Load content to verify it's a series
      const id = await resolveCanonicalContentId(requestedId)
      const rows = await db.select().from(contents).where(eq(contents.id, id)).limit(1)
      const content = rows[0]
      if (!content) {
        set.status = 404
        return { error: 'Content not found' }
      }
      if (content.type !== 'series' && content.type !== 'anime') {
        set.status = 400
        return { error: 'Content is not a series or anime' }
      }

      const episodes = await resolveEpisodes(id)

      // Group episodes by season for the response
      const bySeason = new Map<number, EpisodeInfo[]>()
      for (const ep of episodes) {
        if (!bySeason.has(ep.season)) bySeason.set(ep.season, [])
        bySeason.get(ep.season)!.push(ep)
      }

      const seasons = Array.from(bySeason.entries())
        .sort(([a], [b]) => a - b)
        .map(([season, eps]) => ({
          season,
          episode_count: eps.length,
          episodes: eps,
        }))

      return {
        content: {
          id: content.id,
          title: content.title,
          type: content.type,
        },
        seasons,
      }
    },
    {
      params: t.Object({ id: t.String() }),
      detail: { summary: 'Get structured episode list for a series', tags: ['catalog'] },
    },
  )
  // POST /catalog/:id/refresh — catálogo externo primeiro, torrents depois.
  .post(
    '/catalog/:id/refresh',
    async ({ params, body, jwt, headers, set }) => {
      const auth = await resolveAuth(jwt, headers)
      if (!auth.ok) {
        set.status = auth.status
        return { error: auth.error }
      }

      const id = Number(params.id)
      if (!Number.isInteger(id)) {
        set.status = 400
        return { error: 'Invalid id' }
      }

      try {
        return await refreshOnce(id, body.scope ?? 'all')
      } catch (error) {
        const message = (error as Error).message
        set.status = message === 'Content not found' ? 404 : 502
        return { error: message }
      }
    },
    {
      params: t.Object({ id: t.String() }),
      body: t.Object({
        scope: t.Optional(t.Union([
          t.Literal('all'),
          t.Literal('metadata'),
          t.Literal('sources'),
        ])),
      }),
      detail: {
        summary: 'Refresh one title from external catalogs and torrent sources',
        tags: ['catalog'],
      },
    },
  )
  // POST /catalog/:id/episodes/:season/:episode/refresh — busca novas
  // fontes/qualidades apenas para o card selecionado.
  .post(
    '/catalog/:id/episodes/:season/:episode/refresh',
    async ({ params, jwt, headers, set }) => {
      const auth = await resolveAuth(jwt, headers)
      if (!auth.ok) {
        set.status = auth.status
        return { error: auth.error }
      }

      const requestedId = Number(params.id)
      const season = Number(params.season)
      const episode = Number(params.episode)
      if (
        !Number.isInteger(requestedId) ||
        !Number.isInteger(season) ||
        !Number.isInteger(episode) ||
        season < 1 ||
        episode < 0
      ) {
        set.status = 400
        return { error: 'Invalid content, season or episode' }
      }

      const contentId = await resolveCanonicalContentId(requestedId)
      const [content] = await db
        .select({ type: contents.type })
        .from(contents)
        .where(eq(contents.id, contentId))
        .limit(1)
      if (!content) {
        set.status = 404
        return { error: 'Content not found' }
      }
      if (content.type !== 'series' && content.type !== 'anime') {
        set.status = 400
        return { error: 'Content is not a series or anime' }
      }

      try {
        return await refreshEpisodeSourcesOnce(contentId, season, episode)
      } catch (error) {
        set.status = 502
        return { error: (error as Error).message }
      }
    },
    {
      params: t.Object({
        id: t.String(),
        season: t.String(),
        episode: t.String(),
      }),
      detail: {
        summary: 'Refresh torrent and HTTP sources for one episode',
        tags: ['catalog'],
      },
    },
  )
  // GET /search — search by title (same envelope as /catalog)
  .get(
    '/search/external',
    async ({ query, set }) => {
      const q = query.q.trim()
      if (q.length < 2 || q.length > 80) {
        set.status = 400
        return { error: 'Search query must have between 2 and 80 characters' }
      }
      try {
        return { data: await searchExternalCatalog(q, query.limit ?? 16) }
      } catch (error) {
        set.status = 502
        return { error: (error as Error).message }
      }
    },
    {
      query: t.Object({
        q: t.String(),
        limit: t.Optional(t.Numeric({ minimum: 1, maximum: 20 })),
      }),
      detail: { summary: 'Search TMDB and MyAnimeList catalogs', tags: ['catalog'] },
    },
  )
  .post(
    '/catalog/import',
    async ({ body, jwt, headers, set }) => {
      const auth = await resolveAuth(jwt, headers)
      if (!auth.ok) {
        set.status = auth.status
        return { error: auth.error }
      }
      try {
        return await importExternalCatalog(body)
      } catch (error) {
        const message = (error as Error).message
        set.status = /not found/i.test(message) ? 404 : 400
        return { error: message }
      }
    },
    {
      body: t.Object({
        provider: t.Union([t.Literal('tmdb'), t.Literal('jikan')]),
        externalId: t.Numeric({ minimum: 1 }),
        mediaType: t.Union([t.Literal('movie'), t.Literal('tv'), t.Literal('anime')]),
      }),
      detail: { summary: 'Import a title from an external catalog', tags: ['catalog'] },
    },
  )
  .get(
    '/search',
    async ({ query }) => {
      const { page, limit } = pagination(query)
      const filters = buildFilters({ search: query.q, type: query.type })
      const { data, total } = await listContents({
        filters,
        sort: 'created_at',
        order: 'desc',
        page,
        limit,
      })
      return { data, meta: { page, limit, total } }
    },
    {
      query: t.Object({
        q: t.Optional(t.String()),
        type: t.Optional(t.String()),
        page: t.Optional(t.Numeric()),
        limit: t.Optional(t.Numeric()),
      }),
      detail: { summary: 'Search catalog by title', tags: ['catalog'] },
    },
  )
  // GET /trending — faixas `{ title, source, type, data }` ordenadas PELO
  // PROVEDOR (TMDB trending/day; Jikan top airing), com a lista COMPLETA do
  // provedor (sem filtrar pelo catálogo interno). A lista é persistida em
  // `metadata_cache` e atualizada 1x/dia (refresh preguiçoso no primeiro pedido
  // após 24h). Substitui o "Top 10 de hoje" que o app montava com
  // /catalog?sort=popular (ordem por seeds, não por ranking externo).
  .get(
    '/trending',
    async ({ query, set }) => {
      const limit = Math.min(TRENDING_MAX_LIMIT, Math.max(1, query.limit ?? 10))
      const requested = (query.type ?? 'all').trim().toLowerCase()

      // Sem `type` (ou type=all): devolve as três faixas em um único request,
      // cada uma com seu rótulo. Uma faixa indisponível não afeta as outras.
      if (requested === '' || requested === 'all') {
        const groups = await Promise.all(TRENDING_TYPES.map((type) => getTrendingGroup(type, limit)))
        return { generated_at: new Date().toISOString(), limit, groups }
      }

      const type = normalizeTrendingType(requested)
      if (!type) {
        set.status = 400
        return { error: `Unknown type "${query.type}". Use movie | series | anime | all` }
      }
      return await getTrendingGroup(type, limit)
    },
    {
      query: t.Object({
        type: t.Optional(t.String()),
        limit: t.Optional(t.Numeric()),
      }),
      detail: {
        summary: 'Provider-ranked rows (TMDB trending/day, Jikan top airing) matched to the catalog',
        tags: ['catalog'],
      },
    },
  )
