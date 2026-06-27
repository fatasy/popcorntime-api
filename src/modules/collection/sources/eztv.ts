import { USER_AGENT, type RawTorrent } from '../../../lib/parse'

const EZTV_API = 'https://eztvx.to/api/get-torrents'
const TIMEOUT_MS = 30_000

interface EztvTorrent {
  id: number
  hash: string
  filename: string
  magnet_url: string
  title: string
  imdb_id: string
  season: string
  episode: string
  seeds: number
  peers: number
  date_released_unix: number
  size_bytes: string
}

interface EztvResponse {
  torrents_count: number
  limit: number
  page: number
  torrents: EztvTorrent[]
}

function mapEztvTorrent(r: EztvTorrent): RawTorrent {
  const season = parseInt(r.season, 10)
  const episode = parseInt(r.episode, 10)
  return {
    source: 'eztv',
    hash: r.hash.toLowerCase(),
    title: r.filename || r.title,
    magnet_link: r.magnet_url,
    seeds: r.seeds,
    leechers: r.peers,
    size_bytes: parseInt(r.size_bytes, 10) || null,
    uploader: null,
    category: 'series',
    published_at: r.date_released_unix > 0 ? new Date(r.date_released_unix * 1000) : null,
    season: Number.isFinite(season) ? season : undefined,
    episode: Number.isFinite(episode) ? episode : undefined,
  }
}

/**
 * Strip the 'tt' prefix from an IMDB ID if present.
 * The EZTV API expects the numeric form (e.g. '8772296', not 'tt8772296').
 */
function stripImdbPrefix(imdbId: string): string {
  return imdbId.replace(/^tt/i, '')
}

/**
 * Fetch a single page from the EZTV API.
 * Returns null on failure so the caller can stop paginating.
 */
async function fetchPage(imdbId: string, page: number): Promise<EztvResponse | null> {
  try {
    const numericId = stripImdbPrefix(imdbId)
    const url = `${EZTV_API}?imdb_id=${encodeURIComponent(numericId)}&page=${page}`
    const res = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT, accept: 'application/json' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })

    if (!res.ok) {
      console.warn(`[eztv] HTTP ${res.status} for imdb_id=${imdbId} page=${page}`)
      return null
    }

    const data = (await res.json()) as unknown

    if (!data || typeof data !== 'object') {
      console.warn(`[eztv] unexpected response type for imdb_id=${imdbId} page=${page}`)
      return null
    }

    return data as EztvResponse
  } catch (err) {
    console.warn(`[eztv] page ${page} failed:`, (err as Error).message)
    return null
  }
}

/**
 * Fetch all torrents from EZTV by IMDB ID, paginating through all results.
 * Returns an empty array on any failure (HTTP error, timeout, parse error).
 */
export async function fetchEztvByImdb(imdbId: string): Promise<RawTorrent[]> {
  const all: RawTorrent[] = []
  const seen = new Set<string>()

  try {
    let page = 1
    while (true) {
      const response = await fetchPage(imdbId, page)
      if (!response) break

      const torrents = response.torrents
      if (!Array.isArray(torrents) || torrents.length === 0) break

      for (const t of torrents) {
        const hash = t.hash?.toLowerCase()
        if (hash && !seen.has(hash)) {
          seen.add(hash)
          all.push(mapEztvTorrent(t))
        }
      }

      // Stop if we got fewer results than the page limit (last page) or hit the total count.
      if (torrents.length < response.limit || all.length >= response.torrents_count) break

      page++
    }
  } catch (err) {
    console.warn('[eztv] request failed:', (err as Error).message)
    // Return whatever we collected so far (if any).
  }

  return all
}
