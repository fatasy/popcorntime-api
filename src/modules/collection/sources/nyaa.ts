import { buildMagnet, parseRelease, USER_AGENT, type RawTorrent } from '../../../lib/parse'

const RSS_URL = 'https://nyaa.si/?page=rss'

// ─── Rate limiter ──────────────────────────────────────────────────────────
let lastRequestTime = 0
const MIN_INTERVAL_MS = 3_500 // 3.5s between requests

async function throttle(): Promise<void> {
  const now = Date.now()
  const wait = Math.max(0, MIN_INTERVAL_MS - (now - lastRequestTime))
  if (wait > 0) await Bun.sleep(wait)
  lastRequestTime = Date.now()
}

// ─── Cache ─────────────────────────────────────────────────────────────────
const cache = new Map<string, { data: RawTorrent[]; ts: number }>()
const CACHE_TTL_MS = 30 * 60 * 1000

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

// ─── XML parsing (lightweight — regex-based, no heavy XML lib needed) ─────

interface NyaaItem {
  title: string
  hash: string
  seeds: number
  leechers: number
  sizeBytes: number | null
  pubDate: string | null
  category: string | null
}

function parseRssItems(xml: string): NyaaItem[] {
  const items: NyaaItem[] = []
  // Split by <item>...</item>
  const itemRegex = /<item>([\s\S]*?)<\/item>/gi
  let match

  while ((match = itemRegex.exec(xml)) !== null) {
    const block = match[1]!

    // Extract fields
    const title = extractTag(block, 'title')
    const link = extractTag(block, 'link')
    const guid = extractTag(block, 'guid')
    const pubDate = extractTag(block, 'pubDate')
    const category = extractTag(block, 'category')

    // Seeds/leeches/size from nyaa namespace (nyaa:seeders, etc.)
    const seeds = parseInt(extractTag(block, 'nyaa:seeders') || '0', 10)
    const leechers = parseInt(extractTag(block, 'nyaa:leechers') || '0', 10)
    const sizeStr = extractTag(block, 'nyaa:size')
    const sizeBytes = sizeStr ? parseSize(sizeStr) : null

    // Extract infohash from nyaa:infoHash (primary) or fall back to link/guid
    const infoHash = extractTag(block, 'nyaa:infoHash')
    const hashSource = infoHash || link || guid || ''
    const hashMatch = hashSource.match(/([a-fA-F0-9]{40})/)
    const hash = hashMatch ? hashMatch[1]!.toLowerCase() : ''

    if (!hash || !title) continue

    items.push({ title, hash, seeds, leechers, sizeBytes, pubDate, category })
  }

  return items
}

function extractTag(xml: string, tag: string): string | null {
  const regex = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i')
  const match = xml.match(regex)
  if (!match) return null
  return match[1]!.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').trim()
}

// Parse size like "1.2 GiB", "500.3 MiB", "100 KiB"
function parseSize(s: string): number | null {
  const match = s.match(/^([\d.]+)\s*(GiB|MiB|KiB|GB|MB|KB|B)$/i)
  if (!match) return null
  const num = parseFloat(match[1]!)
  const unit = match[2]!.toUpperCase()
  const multipliers: Record<string, number> = {
    B: 1, KB: 1024, KiB: 1024,
    MB: 1024 ** 2, MiB: 1024 ** 2,
    GB: 1024 ** 3, GiB: 1024 ** 3,
  }
  return Math.round(num * (multipliers[unit] ?? 1))
}

// Parse pubDate like "Sat, 28 Jun 2026 12:00:00 -0000"
function parsePubDate(s: string): Date | null {
  const d = new Date(s)
  return isNaN(d.getTime()) ? null : d
}

// ─── Public API ────────────────────────────────────────────────────────────

/**
 * Search nyaa.si for anime torrents in the English-translated category.
 * Returns up to `limit` results sorted by seeders descending.
 */
export async function searchNyaa(
  query: string,
  limit = 50,
): Promise<RawTorrent[]> {
  const cacheKey = `${query}|${limit}`
  const cached = cacheGet(cacheKey)
  if (cached) return cached

  try {
    await throttle()

    const url = new URL(RSS_URL)
    url.searchParams.set('q', query)
    url.searchParams.set('c', '1_2') // English-translated anime

    const res = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT },
      signal: AbortSignal.timeout(20_000),
    })

    if (!res.ok) {
      console.warn(`[nyaa] HTTP ${res.status} for q="${query}"`)
      cacheSet(cacheKey, [])
      return []
    }

    const xml = await res.text()
    const items = parseRssItems(xml)

    const results: RawTorrent[] = items.map((item) => {
      // Try to parse season/episode for quality extraction
      const parsed = parseRelease(item.title)

      return {
        source: 'nyaa',
        hash: item.hash,
        title: item.title,
        magnet_link: buildMagnet(item.hash, item.title),
        seeds: item.seeds,
        leechers: item.leechers,
        size_bytes: item.sizeBytes,
        uploader: null,
        category: item.category ?? 'anime',
        published_at: item.pubDate ? parsePubDate(item.pubDate) : null,
      }
    })

    // Sort by seeds descending, slice to limit
    results.sort((a, b) => (b.seeds ?? 0) - (a.seeds ?? 0))
    const sliced = results.slice(0, limit)

    cacheSet(cacheKey, sliced)
    return sliced
  } catch (err) {
    console.warn('[nyaa] request failed:', (err as Error).message)
    return []
  }
}

export { parseRssItems } // exported for testing
