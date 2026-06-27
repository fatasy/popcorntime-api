/**
 * LimeTorrents file-list scraper.
 *
 * Strategy:
 * 1. Search LimeTorrents by torrent title (slugified)
 * 2. For each search result (max 5), fetch the detail page & match the info_hash
 *    found in the meta description: `<meta name="description" content="... Hash: INFO_HASH ...">`
 * 3. Parse the "Torrent File Content" section on the detail page
 * 4. Extract quality label from real video filenames
 */

import * as cheerio from 'cheerio'
import { USER_AGENT } from '../../lib/parse'

// ─── Constants ───────────────────────────────────────────────────────────

const LIME_BASE = 'https://www.limetorrents.fun'
const LIME_SEARCH = `${LIME_BASE}/search/all/`
const REQUEST_TIMEOUT_MS = 15_000
const MAX_SEARCH_RESULTS_TO_CHECK = 5

// ─── Types ───────────────────────────────────────────────────────────────

export interface LimeTorrentFile {
  name: string       // original filename
  size: number       // bytes (parsed from "2.91 GB", "127 bytes", etc.)
  type: 'video' | 'audio' | 'document' | 'nfo' | 'directory' | 'unknown'
}

export interface LimeTorrentResult {
  url: string        // detail page URL
  title: string
  hash: string       // uppercase info_hash from meta
  files: LimeTorrentFile[]
  seeders: number
  leechers: number
  sizeBytes: number
}

// ─── Quality patterns ────────────────────────────────────────────────────

/** Ordered highest → lowest so the first match is the best quality. */
const QUALITY_PATTERNS: [RegExp, string][] = [
  [/2160p/i, '2160p'],
  [/4K\b/i, '4K'],
  [/UHD\b/i, '4K'],
  [/1080p/i, '1080p'],
  [/720p/i, '720p'],
  [/480p/i, '480p'],
  [/HDR10\+/i, 'HDR10+'],
  [/HDR10/i, 'HDR10'],
  [/Dolby\s*Vision/i, 'DV'],
  [/DV\b/i, 'DV'],
  [/HDR\b/i, 'HDR'],
  [/x265\b/i, 'x265'],
  [/HEVC\b/i, 'HEVC'],
  [/x264\b/i, 'x264'],
  [/AV1\b/i, 'AV1'],
  [/WEB-DL\b/i, 'WEB-DL'],
  [/WEBRip\b/i, 'WEBRip'],
  [/BluRay\b/i, 'BluRay'],
  [/BRRip\b/i, 'BRRip'],
  [/HDRip\b/i, 'HDRip'],
  [/AMZN\b/i, 'AMZN'],
]

// ─── File type mapping ───────────────────────────────────────────────────

const FILE_TYPE_MAP: Record<string, LimeTorrentFile['type']> = {
  csprite_doc_video: 'video',
  csprite_doc_music: 'audio',
  csprite_doc_doc: 'document',
  csprite_doc_nfo: 'nfo',
  csprite_doc_dir: 'directory',
}

function parseFileType(spanClasses: string): LimeTorrentFile['type'] {
  for (const [cssClass, ftype] of Object.entries(FILE_TYPE_MAP)) {
    if (spanClasses.includes(cssClass)) return ftype
  }
  return 'unknown'
}

// ─── Size parser (LimeTorrents uses decimal units: KB, MB, GB, TB) ──────

/** Parse a LimeTorrents size string like "2.91 GB", "127 bytes", "5.03 KB" into bytes. */
function parseLimeSize(raw: string): number {
  const cleaned = raw.trim()
  // bytes
  if (/bytes?/i.test(cleaned)) {
    const m = cleaned.match(/([\d.,]+)/)
    return m ? parseInt(m[1]!.replace(',', ''), 10) : 0
  }

  const m = cleaned.match(/([\d.,]+)\s*(KB|MB|GB|TB)/i)
  if (!m) return 0

  const value = parseFloat(m[1]!.replace(',', '.'))
  if (Number.isNaN(value)) return 0

  const unit = m[2]!.toUpperCase()
  const mult: Record<string, number> = {
    KB: 1_000,
    MB: 1_000_000,
    GB: 1_000_000_000,
    TB: 1_000_000_000_000,
  }

  return Math.round(value * (mult[unit] ?? 1))
}

// ─── Slugify ─────────────────────────────────────────────────────────────

/**
 * Convert a torrent title into a LimeTorrents search slug:
 * lowercase, non-alphanumeric → spaces, spaces → hyphens, collapse hyphens.
 */
function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')   // non-alphanumeric → space
    .trim()
    .replace(/\s+/g, '-')          // spaces → hyphens
    .replace(/-+/g, '-')           // collapse multiple hyphens
    .replace(/^-|-$/g, '')         // trim leading/trailing hyphens
}

// ─── Sleep helper ────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Random delay between 1000–2000ms */
async function rateLimitDelay(): Promise<void> {
  const ms = 1000 + Math.floor(Math.random() * 1000)
  await sleep(ms)
}

// ─── Fetch helper ────────────────────────────────────────────────────────

async function fetchPage(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT, Accept: 'text/html' },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
    if (!res.ok) {
      console.warn(`[scrape-filelist] HTTP ${res.status} for ${url}`)
      return null
    }
    return await res.text()
  } catch (err) {
    console.warn(`[scrape-filelist] fetch error for ${url}:`, (err as Error).message)
    return null
  }
}

// ─── Search ──────────────────────────────────────────────────────────────

interface SearchHit {
  url: string
  title: string
}

/**
 * Search LimeTorrents and return up to `limit` result URLs.
 * Skips non-torrent links and returns absolute URLs.
 */
async function searchLimeTorrents(
  slug: string,
  limit = MAX_SEARCH_RESULTS_TO_CHECK,
): Promise<SearchHit[]> {
  const searchUrl = `${LIME_SEARCH}${slug}/`
  const html = await fetchPage(searchUrl)
  if (!html) {
    console.warn(`[scrape-filelist] Search returned no HTML for slug="${slug}"`)
    return []
  }

  const $ = cheerio.load(html)
  const hits: SearchHit[] = []

  // LimeTorrents search result table: each result row contains a link
  // with href matching /...-torrent-NUMBER.html
  $('a[href]').each((_, el) => {
    const href = $(el).attr('href') ?? ''
    // Match detail-page URLs: anything ending with -torrent-<digits>.html
    if (/\/[^/]*-torrent-\d+\.html$/i.test(href)) {
      const url = href.startsWith('http') ? href : `${LIME_BASE}${href}`
      const title = $(el).text().trim()
      // Avoid duplicates
      if (!hits.some((h) => h.url === url)) {
        hits.push({ url, title: title || 'Unknown' })
      }
    }
  })

  return hits.slice(0, limit)
}

// ─── Hash extraction ─────────────────────────────────────────────────────

/**
 * Extract info_hash from a LimeTorrents detail page meta description.
 * Example: `<meta name="description" content="... Hash: FD26C9EE4598DC2295C410BDDC18D1C2A1967637 ...">`
 *
 * Returns the hash in uppercase, or null if not found.
 */
function extractHashFromMeta(html: string): string | null {
  const m = html.match(/Hash:\s*([A-Fa-f0-9]{40})/)
  return m ? m[1]!.toUpperCase() : null
}

// ─── File list parsing ───────────────────────────────────────────────────

/**
 * Parse the "Torrent File Content" section from a LimeTorrents detail page.
 * Returns the parsed files array.
 */
function parseFileList(html: string): LimeTorrentFile[] {
  // Find the h2 that starts the file content section
  const h2Index = html.indexOf('<h2>Torrent File Content')
  if (h2Index === -1) {
    console.warn('[scrape-filelist] No "Torrent File Content" heading found')
    return []
  }

  // Slice the HTML from that h2 onwards
  const sectionHtml = html.slice(h2Index)

  const $ = cheerio.load(sectionHtml)
  const files: LimeTorrentFile[] = []

  // Each fileline div may contain multiple entries separated by <br> tags.
  // The first entry often has a directory span (csprite_doc_dir) followed by
  // the directory path, then <br>, then one or more actual file entries.
  //
  // Strategy: for each fileline div, find ALL csprite_doc_* spans.
  // Each span marks a file entry (or directory to skip). The filename is
  // the text between the span and the next element (another span, <br>,
  // or <div class="filelinesize">). The size is always in the nearest
  // subsequent <div class="filelinesize">.
  $('div.fileline').each((_, el) => {
    const line = $(el)

    // Find all file-type spans in this div
    const spans = line.find('span[class*="csprite_doc_"]')

    spans.each((_, spanEl) => {
      const span = $(spanEl)
      const spanClass = span.attr('class') ?? ''
      const ftype = parseFileType(spanClass)

      // Directories are just containers — skip them
      if (ftype === 'directory') return

      // Get the next sibling <div class="filelinesize"> for this file entry.
      // It may be a sibling of the span or a sibling of a parent.
      // Use cheerio to find the nearest filelinesize that follows this span.
      let sizeDiv = span.nextAll('div.filelinesize').first()
      // Also look in the parent fileline
      if (sizeDiv.length === 0) {
        sizeDiv = line.find('div.filelinesize').first()
      }

      const sizeRaw = sizeDiv.text().trim()
      const size = parseLimeSize(sizeRaw)

      // Extract the filename: get the text node(s) between this span and the
      // next element. Cheerio doesn't expose text nodes directly, so we
      // operate on HTML: remove subsequent elements and get remaining text.
      const spanHtml = span.prop('outerHTML') as string
      const lineHtml = line.html() ?? ''
      const spanIndex = lineHtml.indexOf(spanHtml)

      if (spanIndex === -1) return

      // Grab everything after this span
      let after = lineHtml.slice(spanIndex + spanHtml.length)

      // Cut at the next <span, <div, or <br
      const nextTagIdx = Math.min(
        ...['<span', '<div', '<br'].map((tag) => {
          const idx = after.indexOf(tag)
          return idx === -1 ? Infinity : idx
        }),
      )

      if (nextTagIdx !== Infinity && nextTagIdx >= 0) {
        after = after.slice(0, nextTagIdx)
      }

      // Clean up the filename text
      let name = after
        .replace(/<[^>]+>/g, '')     // strip any remaining tags
        .replace(/\u00a0/g, ' ')     // &nbsp; → space
        .replace(/\s*-\s*$/, '')     // trailing " - "
        .trim()

      if (!name) return

      files.push({ name, size, type: ftype })
    })
  })

  return files
}

// ─── Seeders / leechers parsing ──────────────────────────────────────────

/**
 * Extract seeder/leecher counts from the detail page.
 * LimeTorrents typically shows these in spans like:
 * `<span class="greenish">123</span>` for seeders
 * `<span class="reddish">45</span>` for leechers
 * Also: "Seeders : 123" / "Leechers : 45"
 */
function parseStats(html: string): { seeders: number; leechers: number } {
  let seeders = 0
  let leechers = 0

  // Try the "Seeders : N" / "Leechers : N" pattern
  const seedMatch = html.match(/Seeders?\s*:\s*(\d+)/i)
  if (seedMatch) seeders = parseInt(seedMatch[1]!, 10) || 0

  const leechMatch = html.match(/Leechers?\s*:\s*(\d+)/i)
  if (leechMatch) leechers = parseInt(leechMatch[1]!, 10) || 0

  // Also try colored spans
  if (seeders === 0) {
    const greenMatch = html.match(/<span[^>]*class="[^"]*greenish[^"]*"[^>]*>(\d+)<\/span>/i)
    if (greenMatch) seeders = parseInt(greenMatch[1]!, 10) || 0
  }
  if (leechers === 0) {
    const redMatch = html.match(/<span[^>]*class="[^"]*reddish[^"]*"[^>]*>(\d+)<\/span>/i)
    if (redMatch) leechers = parseInt(redMatch[1]!, 10) || 0
  }

  return { seeders, leechers }
}

// ─── Total size parsing ──────────────────────────────────────────────────

function parseTotalSize(html: string): number {
  // Sometimes there's a total size in the page, e.g., "Total size: 2.91 GB"
  const m = html.match(/Total\s*size\s*:\s*([\d.,]+\s*(?:GB|MB|KB|TB|bytes?))/i)
  if (m) return parseLimeSize(m[1]!)

  // Fallback: try the first filelinesize before the file list section
  const sizeMatch = html.match(/<div[^>]*class="filelinesize"[^>]*>([^<]+)<\/div>/i)
  if (sizeMatch) return parseLimeSize(sizeMatch[1]!)

  return 0
}

// ─── Quality extraction from files ───────────────────────────────────────

/**
 * Extract the best quality label from video files in the file list.
 * Returns null if no quality indicator is found.
 */
export function extractQualityFromFiles(files: LimeTorrentFile[]): string | null {
  const videoNames = files
    .filter((f) => f.type === 'video')
    .map((f) => f.name)

  if (videoNames.length === 0) return null

  // Check each pattern in priority order across all video filenames
  for (const [re, label] of QUALITY_PATTERNS) {
    for (const name of videoNames) {
      if (re.test(name)) return label
    }
  }

  return null
}

// ─── Main export ─────────────────────────────────────────────────────────

/**
 * Scrape LimeTorrents for a given torrent title and info_hash.
 *
 * 1. Slugify the title and search LimeTorrents
 * 2. For each search result (max 5), fetch the detail page and check the
 *    info_hash in the meta description
 * 3. On match, parse the file list & extract quality
 *
 * Returns null if no matching torrent is found or if any step fails.
 */
export async function scrapeFileList(
  title: string,
  infoHash: string,
): Promise<LimeTorrentResult | null> {
  const normalizedHash = infoHash.trim().toUpperCase()
  const slug = slugify(title)

  if (!slug) {
    console.warn(`[scrape-filelist] Empty slug for title="${title}"`)
    return null
  }

  console.log(`[scrape-filelist] Searching LimeTorrents for "${slug}" (hash: ${normalizedHash})`)

  // Step 1: Search
  const hits = await searchLimeTorrents(slug)
  if (hits.length === 0) {
    console.warn(`[scrape-filelist] No search results for slug="${slug}"`)
    return null
  }

  console.log(`[scrape-filelist] Found ${hits.length} search results, checking for hash match...`)

  // Step 2: Match by hash
  for (let i = 0; i < hits.length; i++) {
    const hit = hits[i]!

    // Rate-limit between detail page requests
    if (i > 0) await rateLimitDelay()

    const html = await fetchPage(hit.url)
    if (!html) continue

    const pageHash = extractHashFromMeta(html)
    if (!pageHash) {
      console.warn(`[scrape-filelist] No hash in meta description for ${hit.url}`)
      continue
    }

    if (pageHash !== normalizedHash) {
      console.log(`[scrape-filelist] Hash mismatch: expected ${normalizedHash}, got ${pageHash} for ${hit.url}`)
      continue
    }

    // Step 3: Match found — parse detail page
    console.log(`[scrape-filelist] Hash matched! Parsing file list from ${hit.url}`)

    const files = parseFileList(html)
    if (files.length === 0) {
      console.warn(`[scrape-filelist] File list empty for ${hit.url}`)
      return null
    }

    const { seeders, leechers } = parseStats(html)
    const totalSize = parseTotalSize(html)

    const result: LimeTorrentResult = {
      url: hit.url,
      title: hit.title,
      hash: pageHash,
      files,
      seeders,
      leechers,
      sizeBytes: totalSize,
    }

    console.log(
      `[scrape-filelist] Success: ${files.length} files, ${seeders}S/${leechers}L, ` +
        `quality=${extractQualityFromFiles(files) ?? 'unknown'}`,
    )

    return result
  }

  console.warn(
    `[scrape-filelist] No hash match found for "${title}" (hash: ${normalizedHash}) ` +
    `after checking ${hits.length} results`,
  )
  return null
}

// ─── Re-export for convenience ───────────────────────────────────────────

export { slugify }
