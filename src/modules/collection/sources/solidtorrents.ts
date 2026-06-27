import { buildMagnet, USER_AGENT, type RawTorrent } from '../../../lib/parse'

const API = 'https://solidtorrents.to/api/v1/search'

interface SolidTorrentsResult {
  title: string
  infohash: string
  size: number
  seeders: number
  leechers: number
  magnetUri?: string
  id?: string
}

interface SolidTorrentsResponse {
  results: SolidTorrentsResult[]
}

function mapResults(results: SolidTorrentsResult[]): RawTorrent[] {
  return results
    .filter((r) => r.infohash && r.title)
    .map((r) => {
      const hash = r.infohash.toLowerCase()
      return {
        source: 'solidtorrents',
        hash,
        title: r.title,
        magnet_link: buildMagnet(hash, r.title),
        seeds: r.seeders ?? 0,
        leechers: r.leechers ?? 0,
        size_bytes: r.size ?? null,
        uploader: null,
        category: 'series',
        published_at: null,
      } satisfies RawTorrent
    })
}

/**
 * Search SolidTorrents by title query.
 * Returns up to `limit` results (default 50).
 */
export async function searchSolidTorrents(
  query: string,
  limit = 50,
): Promise<RawTorrent[]> {
  try {
    const url = new URL(API)
    url.searchParams.set('q', query)

    const res = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT, accept: 'application/json' },
      signal: AbortSignal.timeout(15_000),
    })
    if (!res.ok) {
      console.warn(`[solidtorrents] HTTP ${res.status} for q="${query}"`)
      return []
    }

    const data = (await res.json()) as SolidTorrentsResponse
    if (!data?.results || !Array.isArray(data.results)) return []

    const results = data.results.slice(0, limit)
    return mapResults(results)
  } catch (err) {
    console.warn('[solidtorrents] request failed:', (err as Error).message)
    return []
  }
}
