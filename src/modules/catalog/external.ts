import { and, eq, isNull, or } from 'drizzle-orm'
import { db } from '../../db'
import {
  anime_franchise_entries,
  contents,
  type NewContent,
} from '../../types'
import { mapJikan, mapTmdb } from '../enrichment'
import {
  getMovie,
  getTV,
  searchMulti,
  tmdbImage,
  type TmdbSearchResult,
} from '../enrichment/tmdb'
import { getAnime, searchAnime, type JikanAnime } from '../enrichment/myanimelist'
import { resolveCanonicalContentId } from '../anime/franchise'
import { refreshCatalogContent } from './refresh'

export type ExternalCatalogProvider = 'tmdb' | 'jikan'
export type ExternalCatalogMediaType = 'movie' | 'tv' | 'anime'

export interface ExternalCatalogResult {
  key: string
  provider: ExternalCatalogProvider
  externalId: number
  mediaType: ExternalCatalogMediaType
  type: 'movie' | 'series' | 'anime'
  title: string
  originalTitle: string | null
  year: number | null
  releaseDate: string | null
  synopsis: string | null
  rating: number | null
  posterUrl: string | null
  backdropUrl: string | null
  existingContentId: number | null
}

export interface ExternalCatalogImportInput {
  provider: ExternalCatalogProvider
  externalId: number
  mediaType: ExternalCatalogMediaType
}

type RawExternalCatalogResult = Omit<ExternalCatalogResult, 'existingContentId'>

const SEARCH_TTL_MS = 10 * 60 * 1_000
const searchCache = new Map<string, { expiresAt: number; data: RawExternalCatalogResult[] }>()
const activeImports = new Map<string, Promise<{ contentId: number; created: boolean }>>()

function dateOnly(value?: string | null): string | null {
  return value?.match(/^(\d{4}-\d{2}-\d{2})/)?.[1] ?? null
}

function yearFromDate(value?: string | null): number | null {
  const year = value?.match(/^(\d{4})/)?.[1]
  return year ? Number(year) : null
}

function mapTmdbSearch(item: TmdbSearchResult): RawExternalCatalogResult | null {
  if (item.media_type !== 'movie' && item.media_type !== 'tv') return null
  // Animes japoneses de TV vêm do Jikan, que conhece a relação entre temporadas.
  // Evita exibir a mesma obra duas vezes e importar cada temporada como outro card.
  if (
    item.media_type === 'tv' &&
    item.original_language === 'ja' &&
    item.genre_ids?.includes(16)
  ) return null

  const releaseDate = dateOnly(item.release_date ?? item.first_air_date)
  const title = item.title ?? item.name
  if (!title) return null
  return {
    key: `tmdb:${item.media_type}:${item.id}`,
    provider: 'tmdb',
    externalId: item.id,
    mediaType: item.media_type,
    type: item.media_type === 'movie' ? 'movie' : 'series',
    title,
    originalTitle: item.original_title ?? item.original_name ?? null,
    year: yearFromDate(releaseDate),
    releaseDate,
    synopsis: item.overview ?? null,
    rating: item.vote_average ?? null,
    posterUrl: tmdbImage(item.poster_path),
    backdropUrl: tmdbImage(item.backdrop_path, 'w780'),
  }
}

function mapJikanSearch(item: JikanAnime): RawExternalCatalogResult | null {
  // Filmes de anime continuam vindo do TMDB. Para séries, o MAL fornece as
  // relações necessárias para juntar temporadas e partes sob uma única obra.
  if (item.type?.toLowerCase() !== 'tv') return null
  const title = item.title_english ?? item.title
  if (!title) return null
  const releaseDate = dateOnly(item.aired?.from)
  return {
    key: `jikan:anime:${item.mal_id}`,
    provider: 'jikan',
    externalId: item.mal_id,
    mediaType: 'anime',
    type: 'anime',
    title,
    originalTitle: item.title_japanese ?? item.title ?? null,
    year: item.year ?? item.aired?.prop?.from?.year ?? yearFromDate(releaseDate),
    releaseDate,
    synopsis: item.synopsis ?? null,
    rating: item.score ?? null,
    posterUrl: item.images?.jpg?.large_image_url ?? item.images?.jpg?.image_url ?? null,
    backdropUrl: null,
  }
}

function animeTitleStem(value?: string | null): string {
  return (value ?? '')
    .toLocaleLowerCase('en')
    .replace(/\b(?:the\s+)?final\s+season\b/gi, ' ')
    .replace(/\b(?:season\s*\d+|\d+(?:st|nd|rd|th)\s+season|part\s*\d+|cour\s*\d+)\b/gi, ' ')
    .replace(/第\s*\d+\s*期/g, ' ')
    .normalize('NFKD')
    .replace(/[^a-z0-9\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]+/gu, ' ')
    .trim()
}

function isExplicitAnimeContinuation(item: JikanAnime): boolean {
  return [item.title, item.title_english, item.title_japanese].some((value) =>
    /\b(?:(?:the\s+)?final\s+season|season\s*\d+|\d+(?:st|nd|rd|th)\s+season|part\s*\d+|cour\s*\d+)\b|第\s*\d+\s*期/i.test(value ?? ''),
  )
}

/**
 * A busca externa deve mostrar a obra, não um card para cada temporada. Se o
 * provedor devolver a raiz e sequências explícitas, conserva apenas a raiz;
 * a consolidação do MAL descobre essas temporadas depois da importação.
 */
function collapseAnimeSeasons(items: JikanAnime[]): JikanAnime[] {
  const roots = items.filter((item) => !isExplicitAnimeContinuation(item))
  if (roots.length === 0) return items
  const rootStems = roots.flatMap((item) =>
    [item.title, item.title_english, item.title_japanese]
      .map(animeTitleStem)
      .filter((title) => title.length >= 4),
  )
  return items.filter((item) => {
    if (!isExplicitAnimeContinuation(item)) return true
    const stems = [item.title, item.title_english, item.title_japanese]
      .map(animeTitleStem)
      .filter((title) => title.length >= 4)
    return !stems.some((stem) => rootStems.some((root) => stem.startsWith(root) || root.startsWith(stem)))
  })
}

function interleave<T>(left: T[], right: T[]): T[] {
  const result: T[] = []
  const length = Math.max(left.length, right.length)
  for (let index = 0; index < length; index++) {
    if (left[index]) result.push(left[index]!)
    if (right[index]) result.push(right[index]!)
  }
  return result
}

async function existingContentId(item: RawExternalCatalogResult): Promise<number | null> {
  if (item.provider === 'jikan') {
    const [franchise] = await db
      .select({ id: anime_franchise_entries.content_id })
      .from(anime_franchise_entries)
      .where(eq(anime_franchise_entries.mal_id, item.externalId))
      .limit(1)
    if (franchise) return resolveCanonicalContentId(franchise.id)

    const [content] = await db
      .select({ id: contents.id })
      .from(contents)
      .where(eq(contents.mal_id, item.externalId))
      .limit(1)
    return content ? resolveCanonicalContentId(content.id) : null
  }

  const [content] = await db
    .select({ id: contents.id })
    .from(contents)
    .where(and(eq(contents.tmdb_id, item.externalId), eq(contents.type, item.type)))
    .limit(1)
  return content ? resolveCanonicalContentId(content.id) : null
}

export async function searchExternalCatalog(
  query: string,
  limit = 16,
): Promise<ExternalCatalogResult[]> {
  const normalized = query.trim().toLocaleLowerCase('pt-BR')
  let raw = searchCache.get(normalized)
  if (!raw || raw.expiresAt <= Date.now()) {
    const [tmdbResult, jikanResult] = await Promise.allSettled([
      searchMulti(query),
      searchAnime(query, Math.min(10, limit)),
    ])
    if (tmdbResult.status === 'rejected') {
      console.warn('[external-search] TMDB failed:', tmdbResult.reason)
    }
    if (jikanResult.status === 'rejected') {
      console.warn('[external-search] Jikan failed:', jikanResult.reason)
    }

    const tmdb = tmdbResult.status === 'fulfilled'
      ? tmdbResult.value.map(mapTmdbSearch).filter((item): item is RawExternalCatalogResult => !!item)
      : []
    const jikan = jikanResult.status === 'fulfilled'
      ? collapseAnimeSeasons(jikanResult.value)
          .map(mapJikanSearch)
          .filter((item): item is RawExternalCatalogResult => !!item)
      : []
    raw = {
      expiresAt: Date.now() + SEARCH_TTL_MS,
      data: interleave(tmdb, jikan).slice(0, limit),
    }
    searchCache.set(normalized, raw)
  }

  return Promise.all(
    raw.data.slice(0, limit).map(async (item) => ({
      ...item,
      existingContentId: await existingContentId(item),
    })),
  )
}

async function findExisting(input: ExternalCatalogImportInput): Promise<number | null> {
  const type = input.provider === 'jikan'
    ? 'anime'
    : input.mediaType === 'movie' ? 'movie' : 'series'
  return existingContentId({
    key: `${input.provider}:${input.mediaType}:${input.externalId}`,
    provider: input.provider,
    externalId: input.externalId,
    mediaType: input.mediaType,
    type,
    title: '',
    originalTitle: null,
    year: null,
    releaseDate: null,
    synopsis: null,
    rating: null,
    posterUrl: null,
    backdropUrl: null,
  })
}

async function findDuplicateByTitle(values: NewContent): Promise<number | null> {
  const titles = [values.title, values.original_title]
    .filter((title): title is string => typeof title === 'string' && title.length > 0)
  if (titles.length === 0) return null
  const titleCondition = or(...titles.flatMap((title) => [
    eq(contents.title, title),
    eq(contents.original_title, title),
  ]))
  const conditions = [
    eq(contents.type, values.type),
    isNull(contents.canonical_content_id),
    titleCondition!,
  ]
  if (typeof values.year === 'number') conditions.push(eq(contents.year, values.year))
  const [duplicate] = await db
    .select({ id: contents.id })
    .from(contents)
    .where(and(...conditions))
    .limit(1)
  return duplicate?.id ?? null
}

async function importOnce(
  input: ExternalCatalogImportInput,
): Promise<{ contentId: number; created: boolean }> {
  const existing = await findExisting(input)
  if (existing) return { contentId: existing, created: false }

  let values: NewContent
  if (input.provider === 'jikan') {
    if (input.mediaType !== 'anime') throw new Error('Invalid Jikan media type')
    const anime = await getAnime(input.externalId)
    if (!anime) throw new Error('Anime not found in external catalog')
    if (anime.type?.toLowerCase() !== 'tv') throw new Error('Only TV anime can be imported here')
    const mapped = mapJikan(anime)
    if (!mapped.title) throw new Error('External catalog returned a title without a name')
    values = {
      type: 'anime',
      title: mapped.title,
      ...mapped,
      enriched_at: new Date(),
      updated_at: new Date(),
    }
  } else {
    if (input.mediaType !== 'movie' && input.mediaType !== 'tv') {
      throw new Error('Invalid TMDB media type')
    }
    const details = input.mediaType === 'movie'
      ? await getMovie(input.externalId)
      : await getTV(input.externalId)
    const mapped = mapTmdb(details, input.mediaType)
    if (!mapped.title) throw new Error('External catalog returned a title without a name')
    values = {
      type: input.mediaType === 'movie' ? 'movie' : 'series',
      title: mapped.title,
      ...mapped,
      enriched_at: new Date(),
      updated_at: new Date(),
    }
  }

  const duplicate = await findDuplicateByTitle(values)
  if (duplicate) return { contentId: duplicate, created: false }

  const [created] = await db.insert(contents).values(values).returning()
  if (!created) throw new Error('Could not add title to catalog')
  return { contentId: created.id, created: true }
}

export async function importExternalCatalog(input: ExternalCatalogImportInput): Promise<{
  contentId: number
  created: boolean
  sourcesStatus: 'queued' | 'already_exists'
}> {
  if (!Number.isInteger(input.externalId) || input.externalId <= 0) {
    throw new Error('Invalid external id')
  }
  if (
    (input.provider === 'tmdb' && input.mediaType === 'anime') ||
    (input.provider === 'jikan' && input.mediaType !== 'anime')
  ) throw new Error('Provider and media type do not match')

  const key = `${input.provider}:${input.mediaType}:${input.externalId}`
  const running = activeImports.get(key)
  const result = running ?? importOnce(input).finally(() => activeImports.delete(key))
  if (!running) activeImports.set(key, result)
  const imported = await result

  if (imported.created) {
    // A inclusão responde assim que os metadados estão disponíveis. A procura
    // de torrents e episódios continua em segundo plano e aparece na tela de detalhes.
    void refreshCatalogContent(imported.contentId, 'sources').catch((error) => {
      console.warn(
        `[external-import] source refresh failed for content ${imported.contentId}:`,
        (error as Error).message,
      )
    })
  }

  return {
    ...imported,
    sourcesStatus: imported.created ? 'queued' : 'already_exists',
  }
}
