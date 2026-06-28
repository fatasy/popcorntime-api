import { buildMagnet, USER_AGENT, type RawTorrent } from '../../../lib/parse'

const API = 'https://solidtorrents.to/api/v1/search'

// ─── Rate limiter ──────────────────────────────────────────────────────────
let lastRequestTime = 0
const MIN_INTERVAL_MS = 2_500 // 2.5s between requests

async function throttle(): Promise<void> {
  const now = Date.now()
  const wait = Math.max(0, MIN_INTERVAL_MS - (now - lastRequestTime))
  if (wait > 0) await Bun.sleep(wait)
  lastRequestTime = Date.now()
}

// ─── In-memory cache ───────────────────────────────────────────────────────
const cache = new Map<string, { data: RawTorrent[]; ts: number }>()
const CACHE_TTL_MS = 30 * 60 * 1000 // 30 minutes

function cacheGet(key: string): RawTorrent[] | null {
  const entry = cache.get(key)
  if (!entry) return null
  if (Date.now() - entry.ts > CACHE_TTL_MS) {
    cache.delete(key)
    return null
  }
  return entry.data
}

function cacheSet(key: string, data: RawTorrent[]): void {
  cache.set(key, { data, ts: Date.now() })
}

// ─── Types ─────────────────────────────────────────────────────────────────

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

// ─── Mapping ───────────────────────────────────────────────────────────────

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

// ─── Retry helper ──────────────────────────────────────────────────────────

async function fetchWithRetry(url: URL): Promise<Response> {
  const MAX_RETRIES = 2
  let lastError: Error | null = null

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': USER_AGENT, accept: 'application/json' },
        signal: AbortSignal.timeout(15_000),
      })

      if (res.status === 429) {
        if (attempt === MAX_RETRIES) {
          console.warn(
            `[solidtorrents] 429 rate-limited after ${MAX_RETRIES + 1} attempts — giving up for "${url.searchParams.get('q')}"`,
          )
          throw new Error('Rate-limited: max retries exceeded')
        }
        const retryAfter = res.headers.get('Retry-After')
        const delay = retryAfter
          ? parseInt(retryAfter, 10) * 1000
          : Math.min(3_000 * Math.pow(2, attempt), 20_000)
        console.warn(
          `[solidtorrents] 429 rate-limited, retrying in ${delay / 1000}s (attempt ${attempt + 1}/${MAX_RETRIES + 1})`,
        )
        await Bun.sleep(delay)
        continue
      }

      if (!res.ok) {
        console.warn(`[solidtorrents] HTTP ${res.status} for q="${url.searchParams.get('q')}"`)
        throw new Error(`HTTP ${res.status}`)
      }

      return res
    } catch (err) {
      lastError = err as Error
      if (attempt < MAX_RETRIES) {
        const delay = Math.min(2_000 * Math.pow(2, attempt), 30_000)
        await Bun.sleep(delay)
      }
    }
  }

  throw lastError ?? new Error('Max retries exceeded')
}

// ─── Public API ────────────────────────────────────────────────────────────

/**
 * Search SolidTorrents by title query.
 * Returns up to `limit` results (default 50).
 * Includes rate limiting (2.5s min between requests), retry on 429,
 * and 30-minute in-memory cache.
 */
export async function searchSolidTorrents(
  query: string,
  limit = 50,
): Promise<RawTorrent[]> {
  // Check cache first
  const cacheKey = `${query}|${limit}`
  const cached = cacheGet(cacheKey)
  if (cached) return cached

  try {
    await throttle()

    const url = new URL(API)
    url.searchParams.set('q', query)

    const res = await fetchWithRetry(url)
    const data = (await res.json()) as SolidTorrentsResponse

    if (!data?.results || !Array.isArray(data.results)) {
      cacheSet(cacheKey, [])
      return []
    }

    const results = data.results.slice(0, limit)
    const mapped = mapResults(results)
    cacheSet(cacheKey, mapped)
    return mapped
  } catch (err) {
    console.warn('[solidtorrents] request failed:', (err as Error).message)
    return []
  }
}
