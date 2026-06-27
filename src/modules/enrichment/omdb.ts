import { env } from '../../env'

const BASE = 'https://www.omdbapi.com/'

export interface OmdbResult {
  Response: 'True' | 'False'
  Title?: string
  Year?: string
  Genre?: string
  Plot?: string
  imdbRating?: string
  Poster?: string
  imdbID?: string
  Runtime?: string
  Country?: string
  Director?: string
  Actors?: string
  Type?: string
  Error?: string
}

/** OMDb lookup by exact title (optionally year), used as a movie fallback. */
export async function searchByTitle(
  title: string,
  year?: number | null,
): Promise<OmdbResult | null> {
  try {
    const url = new URL(BASE)
    url.searchParams.set('apikey', env.OMDb_API_KEY)
    url.searchParams.set('t', title)
    if (year) url.searchParams.set('y', String(year))
    url.searchParams.set('plot', 'full')

    const res = await fetch(url, { signal: AbortSignal.timeout(15_000) })
    if (!res.ok) {
      console.warn(`[omdb] HTTP ${res.status} for "${title}"`)
      return null
    }
    const data = (await res.json()) as OmdbResult
    if (data.Response === 'False') return null
    return data
  } catch (err) {
    console.warn('[omdb] request failed:', (err as Error).message)
    return null
  }
}
