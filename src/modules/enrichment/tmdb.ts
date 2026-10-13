import { env } from '../../env'
import { CHINESE_FANTASY_KEYWORD_IDS } from '../catalog/chinese-fantasy'

const BASE = 'https://api.themoviedb.org/3'
const IMAGE_BASE = 'https://image.tmdb.org/t/p'

function authHeaders() {
  return {
    Authorization: `Bearer ${env.TMDB_API_KEY}`,
    accept: 'application/json',
  }
}

async function tmdbGet<T = any>(
  path: string,
  params: Record<string, string | number | undefined> = {},
): Promise<T> {
  const url = new URL(BASE + path)
  url.searchParams.set('api_key', env.TMDB_API_KEY)
  for (const [k, v] of Object.entries(params)) {
    if (v != null) url.searchParams.set(k, String(v))
  }
  const res = await fetch(url, {
    signal: AbortSignal.timeout(15_000),
  })
  if (!res.ok) {
    throw new Error(`TMDB ${res.status} on ${path}`)
  }
  return (await res.json()) as T
}

export interface TmdbSearchResult {
  id: number
  media_type: 'movie' | 'tv' | 'person'
  title?: string
  name?: string
  original_title?: string
  original_name?: string
  overview?: string
  release_date?: string
  first_air_date?: string
  vote_average?: number
  poster_path?: string | null
  backdrop_path?: string | null
  genre_ids?: number[]
  original_language?: string
}

/** Multi search (movies + tv), defaults to Brazilian Portuguese. */
export async function searchMulti(
  query: string,
  language = 'pt-BR',
): Promise<TmdbSearchResult[]> {
  const data = await tmdbGet<{ results?: TmdbSearchResult[] }>('/search/multi', {
    query,
    language,
    include_adult: 'false',
  })
  return (data.results ?? []).filter(
    (r) => r.media_type === 'movie' || r.media_type === 'tv',
  )
}

/** Full movie details incl. credits + external ids (imdb). */
export async function getMovie(id: number, language = 'pt-BR'): Promise<any> {
  return tmdbGet(`/movie/${id}`, {
    language,
    append_to_response: 'credits,external_ids,keywords',
  })
}

/** Full TV details incl. credits + external ids (imdb). */
export async function getTV(id: number, language = 'pt-BR'): Promise<any> {
  return tmdbGet(`/tv/${id}`, {
    language,
    append_to_response: 'credits,external_ids,keywords',
  })
}

export async function getTVAlternativeTitles(id: number): Promise<{ results?: { title?: string; type?: string }[] }> {
  return tmdbGet(`/tv/${id}/alternative_titles`)
}

/**
 * Um episódio de temporada no TMDB. `still_path` é a ÚNICA fonte de imagem
 * por episódio disponível nos provedores já integrados (Jikan/MAL não expõe
 * imagem por episódio) — resolvida via `tmdbImage(still_path, 'w300')`.
 */
export interface TmdbSeasonEpisode {
  id?: number
  season_number?: number
  episode_number: number
  name?: string | null
  overview?: string | null
  air_date?: string | null
  runtime?: number | null
  still_path?: string | null
}

export interface TmdbSeason {
  season_number?: number
  episodes?: TmdbSeasonEpisode[]
}

/** Full episode list for a TV season. */
export async function getSeasonEpisodes(tvId: number, seasonNumber: number, language = 'pt-BR'): Promise<TmdbSeason> {
  return tmdbGet<TmdbSeason>(`/tv/${tvId}/season/${seasonNumber}`, { language })
}

export function tmdbImage(path?: string | null, size = 'w500'): string | null {
  return path ? `${IMAGE_BASE}/${size}${path}` : null
}

// ─── Discovery endpoints ─────────────────────────────────────────────

export interface TmdbDiscoverItem {
  id: number
  title?: string
  name?: string
  original_title?: string
  original_name?: string
  overview?: string
  poster_path?: string | null
  backdrop_path?: string | null
  release_date?: string
  first_air_date?: string
  vote_average?: number
  genre_ids?: number[]
  popularity?: number
}

async function discoverPaginated(path: string, pages = 2, params: Record<string, string | number | undefined> = {}): Promise<TmdbDiscoverItem[]> {
  const results: TmdbDiscoverItem[] = []
  for (let page = 1; page <= pages; page++) {
    try {
      const data = await tmdbGet<{ results?: TmdbDiscoverItem[]; total_pages?: number }>(path, {
        ...params,
        page,
        language: 'pt-BR',
        region: 'BR',
      })
      if (data.results?.length) results.push(...data.results)
      if (data.total_pages != null && page >= data.total_pages) break
    } catch (err) {
      console.warn(`[tmdb] ${path} page ${page} failed:`, (err as Error).message)
    }
  }
  return results
}

/** Movies now playing in theatres. */
export function getNowPlayingMovies(pages = 2) {
  return discoverPaginated('/movie/now_playing', pages)
}

/** Popular movies. */
export function getPopularMovies(pages = 2) {
  return discoverPaginated('/movie/popular', pages)
}

/** Trending movies this week. */
export function getTrendingMovies(pages = 1) {
  return discoverPaginated('/trending/movie/week', pages)
}

/** Popular TV shows. */
export function getPopularTV(pages = 2) {
  return discoverPaginated('/tv/popular', pages)
}

/** Trending TV this week. */
export function getTrendingTV(pages = 1) {
  return discoverPaginated('/trending/tv/week', pages)
}

/** TV shows currently on the air. */
export function getOnTheAirTV(pages = 2) {
  return discoverPaginated('/tv/on_the_air', pages)
}

/**
 * Trending DIÁRIO do TMDB (`/trending/{movie|tv}/day`) — é um RANKING REAL do
 * provedor, recalculado ao longo do dia. Alimenta a faixa "Em alta hoje" do app
 * via `GET /trending`. Difere de `getTrendingMovies`/`getTrendingTV` (semanais,
 * usados pelo job de descoberta) e de `discoverPaginated`: LANÇA em falha de
 * HTTP, para o chamador distinguir "provedor fora do ar" de "lista vazia".
 */
export async function getTrendingDaily(
  media: 'movie' | 'tv',
  pages = 1,
): Promise<TmdbDiscoverItem[]> {
  const out: TmdbDiscoverItem[] = []
  for (let page = 1; page <= pages; page++) {
    const data = await tmdbGet<{ results?: TmdbDiscoverItem[]; total_pages?: number }>(
      `/trending/${media}/day`,
      { page, language: 'pt-BR' },
    )
    if (!data.results?.length) break
    out.push(...data.results)
    if (data.total_pages != null && page >= data.total_pages) break
  }
  return out
}

/** Discover anime via TMDB (genre 16 = animation + keyword "anime" = 210024). */
export function discoverAnime(pages = 2) {
  return discoverPaginated('/discover/tv', pages, {
    with_genres: '16',
    with_keywords: '210024',
    with_original_language: 'ja',
    sort_by: 'popularity.desc',
  })
}

/** Anime with episodes aired recently; the provider's popularity order is retained. */
export async function getAiringAnime(pages = 2): Promise<TmdbDiscoverItem[]> {
  const today = new Date()
  const since = new Date(today.getTime() - 30 * 86400_000)
  const out: TmdbDiscoverItem[] = []
  for (let page = 1; page <= pages; page++) {
    const data = await tmdbGet<{ results?: TmdbDiscoverItem[]; total_pages?: number }>('/discover/tv', {
      page, language: 'pt-BR', include_adult: 'false',
      with_genres: '16', with_original_language: 'ja',
      'air_date.gte': since.toISOString().slice(0, 10),
      'air_date.lte': today.toISOString().slice(0, 10),
      sort_by: 'popularity.desc',
    })
    if (!data.results?.length) break
    out.push(...data.results)
    if (data.total_pages != null && page >= data.total_pages) break
  }
  return out
}

/** Separate discovery pages keep both donghua and live-action novels represented. */
export async function discoverChineseFantasy(animated: boolean, pages = 2): Promise<TmdbDiscoverItem[]> {
  const out: TmdbDiscoverItem[] = []
  for (let page = 1; page <= pages; page++) {
    const data = await tmdbGet<{ results?: TmdbDiscoverItem[]; total_pages?: number }>('/discover/tv', {
      page, language: 'pt-BR', include_adult: 'false', with_origin_country: 'CN',
      with_keywords: CHINESE_FANTASY_KEYWORD_IDS.join('|'),
      ...(animated ? { with_genres: '16' } : { without_genres: '16' }),
      'first_air_date.lte': new Date().toISOString().slice(0, 10),
      sort_by: 'popularity.desc',
    })
    if (!data.results?.length) break
    out.push(...data.results)
    if (data.total_pages != null && page >= data.total_pages) break
  }
  return out
}
