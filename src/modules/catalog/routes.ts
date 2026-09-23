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
import { extractQuality } from '../../lib/parse'
import { jwtPlugin } from '../auth/jwt'
import { resolveAuth } from '../auth/guard'
import { refreshCatalogContent, type CatalogRefreshResult, type RefreshScope } from './refresh'
import { resolveCanonicalContentId } from '../anime/franchise'
import { fillGaps } from '../collection/fill-gaps'

// Evita que dois cliques (ou dois dispositivos) disparem o mesmo crawler em
// paralelo para um título. Todos aguardam a execução já em curso.
const activeRefreshes = new Map<number, Promise<CatalogRefreshResult>>()

interface EpisodeSourceRefreshResult {
  contentId: number
  season: number
  episode: number
  sourcesFound: number
  sourcesAdded: number
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
  return row?.value ?? 0
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
  const aliases = GENRE_ALIASES[genre] ?? [genre]
  const ors = aliases.map((g) => sql`${g} = ANY(${contents.genres})`)
  return ors.length === 1 ? ors[0]! : or(...ors)!
}

function buildFilters(input: FilterInput): SQL[] {
  // Aliases preservam URLs/favoritos antigos, mas nunca aparecem como outro
  // card no catálogo.
  const conds: SQL[] = [isNull(contents.canonical_content_id)]
  if (input.type) conds.push(eq(contents.type, input.type))
  if (input.year != null) conds.push(eq(contents.year, input.year))
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
  sort: SortKey | 'popular'
  order: 'asc' | 'desc'
  page: number
  limit: number
}

async function listContents(opts: ListOptions) {
  const where = opts.filters.length ? and(...opts.filters) : undefined
  const offset = (opts.page - 1) * opts.limit

  // Popularity sort: order by primary torrent seeds (content with most seeds first)
  const isPopular = opts.sort === 'popular'
  const sortCol = isPopular ? POPULARITY_SQL : (SORT_COLUMNS[opts.sort as SortKey] ?? contents.created_at)
  const orderBy = opts.order === 'asc' ? asc(sortCol) : desc(sortCol)

  const rows = await db
    .select()
    .from(contents)
    .where(where)
    .orderBy(orderBy, desc(contents.id))
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

  const data = rows.map((row) => ({ ...row, primary: primaryByContent.get(row.id) ? { ...primaryByContent.get(row.id), quality: extractQuality(primaryByContent.get(row.id)!.title) } : null }))
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
      })
      const isValidSort = query.sort === 'popular' || (query.sort != null && query.sort in SORT_COLUMNS)
      const sort = isValidSort ? (query.sort as SortKey | 'popular') : 'created_at'
      const order = query.order === 'asc' ? 'asc' : 'desc'
      const { data, total } = await listContents({ filters, sort, order, page, limit })
      return { data, meta: { page, limit, total } }
    },
    {
      query: t.Object({
        type: t.Optional(t.String()),
        genre: t.Optional(t.String()),
        year: t.Optional(t.Numeric()),
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

      // Add quality to each linked torrent
      const linkedWithQuality = linked.map((t: any) => ({ ...t, quality: extractQuality(t.title) }))

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
        summary: 'Refresh torrent sources for one episode',
        tags: ['catalog'],
      },
    },
  )
  // GET /search — search by title (same envelope as /catalog)
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
