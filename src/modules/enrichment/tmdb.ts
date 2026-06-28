import { env } from '../../env'

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
    append_to_response: 'credits,external_ids',
  })
}

/** Full TV details incl. credits + external ids (imdb). */
export async function getTV(id: number, language = 'pt-BR'): Promise<any> {
  return tmdbGet(`/tv/${id}`, {
    language,
    append_to_response: 'credits,external_ids',
  })
}

/** Full episode list for a TV season. */
export async function getSeasonEpisodes(tvId: number, seasonNumber: number, language = 'pt-BR'): Promise<any> {
  return tmdbGet(`/tv/${tvId}/season/${seasonNumber}`, { language })
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

/** Discover anime via TMDB (genre 16 = animation + keyword "anime" = 210024). */
export function discoverAnime(pages = 2) {
  return discoverPaginated('/discover/tv', pages, {
    with_genres: '16',
    with_keywords: '210024',
    with_original_language: 'ja',
    sort_by: 'popularity.desc',
  })
}
