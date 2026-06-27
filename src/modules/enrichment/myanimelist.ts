// Jikan v4 — unofficial MyAnimeList API, no auth required.
const BASE = 'https://api.jikan.moe/v4'

export interface JikanAnime {
  mal_id: number
  title?: string
  title_english?: string | null
  title_japanese?: string | null
  synopsis?: string | null
  score?: number | null
  episodes?: number | null
  duration?: string | null
  year?: number | null
  aired?: { prop?: { from?: { year?: number | null } } }
  images?: { jpg?: { image_url?: string; large_image_url?: string } }
  genres?: { name: string }[]
  studios?: { name: string }[]
}

/** Search anime by title. */
export async function searchAnime(query: string, limit = 5): Promise<JikanAnime[]> {
  try {
    const url = new URL(BASE + '/anime')
    url.searchParams.set('q', query)
    url.searchParams.set('limit', String(limit))
    url.searchParams.set('sfw', 'true')

    const res = await fetch(url, { signal: AbortSignal.timeout(15_000) })
    if (!res.ok) {
      console.warn(`[jikan] HTTP ${res.status} for "${query}"`)
      return []
    }
    const data = (await res.json()) as { data?: JikanAnime[] }
    return data.data ?? []
  } catch (err) {
    console.warn('[jikan] search failed:', (err as Error).message)
    return []
  }
}

/** Fetch a single anime by MAL id. */
export async function getAnime(id: number): Promise<JikanAnime | null> {
  try {
    const res = await fetch(`${BASE}/anime/${id}`, {
      signal: AbortSignal.timeout(15_000),
    })
    if (!res.ok) return null
    const data = (await res.json()) as { data?: JikanAnime }
    return data.data ?? null
  } catch (err) {
    console.warn('[jikan] getAnime failed:', (err as Error).message)
    return null
  }
}
