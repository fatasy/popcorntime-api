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
