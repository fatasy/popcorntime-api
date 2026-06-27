import { buildMagnet, USER_AGENT, type RawTorrent } from '../../../lib/parse'

const APIBAY = 'https://apibay.org/q.php'
const PRECOMPILED = 'https://apibay.org/precompiled/data_top100'
const NO_RESULTS_HASH = '0000000000000000000000000000000000000000'

interface ApibayRow {
  id: string
  name: string
  info_hash: string
  leechers: string
  seeders: string
  num_files: string
  size: string
  username: string
  added: string
  status: string
  category: string
  imdb: string
}

function mapRows(rows: ApibayRow[], category: string): RawTorrent[] {
  return rows
    .filter(
      (r) =>
        r.info_hash &&
        r.info_hash !== NO_RESULTS_HASH &&
        r.name &&
        r.name !== 'No results returned',
    )
    .map((r) => {
      const hash = r.info_hash.toLowerCase()
      const added = parseInt(r.added, 10)
      return {
        source: 'apibay',
        hash,
        title: r.name,
        magnet_link: buildMagnet(hash, r.name),
        seeds: parseInt(r.seeders, 10) || 0,
        leechers: parseInt(r.leechers, 10) || 0,
        size_bytes: parseInt(r.size, 10) || null,
        uploader: r.username || null,
        category,
        published_at: Number.isFinite(added) && added > 0 ? new Date(added * 1000) : null,
      } satisfies RawTorrent
    })
}

/**
 * Fetch the top 100 torrents for a category from apibay's precompiled endpoint.
 * This is the PRIMARY data source — TPB's HTML is JS-rendered and unscrapeable.
 * Endpoint: https://apibay.org/precompiled/data_top100_<cat>.json
 */
export async function fetchApibayTop100(cat: number, category: string): Promise<RawTorrent[]> {
  try {
    const url = `${PRECOMPILED}_${cat}.json`
    const res = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT, accept: 'application/json' },
      signal: AbortSignal.timeout(15_000),
    })
    if (!res.ok) {
      console.warn(`[apibay/top100] HTTP ${res.status} cat=${cat}`)
      return []
    }
    const rows = (await res.json()) as ApibayRow[]
    if (!Array.isArray(rows)) return []
    return mapRows(rows, category)
  } catch (err) {
    console.warn('[apibay/top100] request failed:', (err as Error).message)
    return []
  }
}

/**
 * Query apibay (the JSON backend behind The Pirate Bay).
 * `q.php?q=TERM&cat=XXX`. Use for targeted searches, not listings.
 */
export async function queryApibay(
  query: string,
  cat?: number,
  category = 'movies',
): Promise<RawTorrent[]> {
  try {
    const url = new URL(APIBAY)
    url.searchParams.set('q', query)
    if (cat != null) url.searchParams.set('cat', String(cat))

    const res = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT, accept: 'application/json' },
      signal: AbortSignal.timeout(15_000),
    })
    if (!res.ok) {
      console.warn(`[apibay] HTTP ${res.status} for q="${query}"`)
      return []
    }

    const rows = (await res.json()) as ApibayRow[]
    if (!Array.isArray(rows)) return []
    return mapRows(rows, category)
  } catch (err) {
    console.warn('[apibay] request failed:', (err as Error).message)
    return []
  }
}
