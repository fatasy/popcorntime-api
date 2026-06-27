// Shared parsing/normalization helpers used by collection, grouping and enrichment.

export const USER_AGENT =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'

// A normalized raw torrent as produced by every collection source.
export interface RawTorrent {
  source: string // 'tpb' | 'apibay' | 'eztv'
  hash: string // info hash, lower-cased
  title: string
  magnet_link: string
  seeds: number
  leechers: number
  size_bytes: number | null
  uploader: string | null
  category: string // our label: 'movies' | 'series' | 'anime'
  published_at: Date | null
  season?: number
  episode?: number
}

export interface ParsedRelease {
  title: string
  year: number | null
  season: number | null
  episode: number | null
}

// Public trackers appended to magnets we build ourselves (apibay style).
const TRACKERS = [
  'udp://tracker.opentrackr.org:1337/announce',
  'udp://open.stealth.si:80/announce',
  'udp://tracker.torrent.eu.org:451/announce',
  'udp://exodus.desync.com:6969/announce',
  'udp://open.demonii.com:1337/announce',
]

// Tokens that mark the end of a human title inside a release name.
const JUNK =
  /\b(1080p|2160p|720p|480p|4k|uhd|hdr10?|x264|x265|h\.?264|h\.?265|hevc|avc|bluray|blu-ray|brrip|bdrip|webrip|web-?dl|web|hdrip|dvdrip|hdtv|remux|proper|repack|extended|unrated|imax|dual|dublado|legendado|nacional|multi|aac|ac3|dts|ddp?5\.?1|10bit|8bit|amzn|nf|dsnp|hmax|atvp)\b/i

const LEADING_GROUP = /^\s*\[[^\]]*\]\s*/g

// Quality extraction (ordered highest → lowest)
const QUALITY_PATTERNS: [RegExp, string][] = [
  [/\b2160p\b/i, '2160p'],
  [/\b4k\b/i, '4K'],
  [/\buhd\b/i, '4K'],
  [/\b1080p\b/i, '1080p'],
  [/\b720p\b/i, '720p'],
  [/\b480p\b/i, '480p'],
  [/\b360p\b/i, '360p'],
  [/\bremux\b/i, 'REMUX'],
  [/\bhdr10?\b/i, 'HDR'],
]

/** Extract quality label from a torrent title. Returns "1080p", "4K", "720p", "Unknown" etc. */
export function extractQuality(title: string): string {
  for (const [re, label] of QUALITY_PATTERNS) {
    if (re.test(title)) return label
  }
  return 'Unknown'
}

export function buildMagnet(hash: string, name: string): string {
  const trackers = TRACKERS.map((t) => `&tr=${encodeURIComponent(t)}`).join('')
  return `magnet:?xt=urn:btih:${hash}&dn=${encodeURIComponent(name)}${trackers}`
}

export function extractHash(magnet: string): string | null {
  const m = magnet.match(/btih:([a-z0-9]+)/i)
  return m ? m[1]!.toLowerCase() : null
}

// "1.4 GiB" / "700 MB" -> bytes
export function parseSizeToBytes(input: string): number | null {
  const m = input.match(/([\d.,]+)\s*([KMGT]i?)?B/i)
  if (!m) return null
  const value = parseFloat(m[1]!.replace(',', '.'))
  if (Number.isNaN(value)) return null
  const unit = (m[2] ?? '').toUpperCase().replace('I', '')
  const mult: Record<string, number> = {
    '': 1,
    K: 1024,
    M: 1024 ** 2,
    G: 1024 ** 3,
    T: 1024 ** 4,
  }
  return Math.round(value * (mult[unit] ?? 1))
}

// Normalize a title for fuzzy matching (lowercase, strip accents/punctuation).
export function normalizeTitle(input: string): string {
  return input
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[._]+/g, ' ')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

// Extract a clean title + year/season/episode from a torrent release name.
export function parseRelease(raw: string): ParsedRelease {
  let s = raw
    .replace(LEADING_GROUP, '') // drop leading [Group] tags (common for anime)
    .replace(/[._]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

  let season: number | null = null
  let episode: number | null = null
  let year: number | null = null

  const se = s.match(/\bs(\d{1,2})\s*e(\d{1,3})\b/i)
  if (se) {
    season = parseInt(se[1]!, 10)
    episode = parseInt(se[2]!, 10)
  } else {
    const seasonOnly =
      s.match(/\bs(\d{1,2})\b/i) ?? s.match(/\bseason\s*(\d{1,2})\b/i)
    if (seasonOnly) season = parseInt(seasonOnly[1]!, 10)
    const epOnly = s.match(/\bep(?:isode)?\s*(\d{1,3})\b/i)
    if (epOnly) episode = parseInt(epOnly[1]!, 10)
  }

  // anime-style trailing episode: "Title - 12" / "Title - 012v2"
  if (episode == null) {
    const dash = s.match(/\s-\s(\d{1,3})(?:v\d)?\b/)
    if (dash) episode = parseInt(dash[1]!, 10)
  }

  const ym = s.match(/\b(19\d{2}|20\d{2})\b/)
  if (ym) year = parseInt(ym[1]!, 10)

  // Strip common release-group suffixes: "Title - groupname"
  const groupStrip = s.match(/\s[-–]\s(threesixtyp|yify|yts|rarbg|ettv|eztv|galaxy|tgx|psa|ion10|fum|avi|rmteam|megusta|kickass|sadece|panda|mazemaze|judas|sujaidr|tigole|qxr|utr|hone|tigole|sartre|samdew|edge2020|hax0r|x0r|anoXmous|phun|psyz|vyndros|prof|playxd|morphin|ntb|flux|avs|defiant|noname|noscreens|ctrlhd|pignus|3lt0n|lam |o0w0o|t3k |saur0n|tsp |kralimarko|s0n1c|pr0n |mp4upload|tbs|include|verboten|end)\b/i)
  if (groupStrip?.index != null) {
    s = s.slice(0, groupStrip.index).trim()
  }

  // Cut the title at the earliest "metadata" marker we found.
  const markers: number[] = []
  const seasonIdx = s.search(/\bs\d{1,2}(\s*e\d{1,3})?\b/i)
  if (seasonIdx >= 0) markers.push(seasonIdx)
  // "Season 1", "Seasons 1-3", "COMPLETE SEASON", "Complete Series"
  const seasonWordIdx = s.search(/\b(?:seasons?|complete)\b(?:\s+\d[\d,\s\-&+]*)?/i)
  if (seasonWordIdx >= 0 && seasonWordIdx > 2) markers.push(seasonWordIdx)
  if (ym) markers.push(ym.index!)
  const junkIdx = s.search(JUNK)
  if (junkIdx >= 0) markers.push(junkIdx)
  const dashIdx = s.search(/\s[-–]\s\d{1,3}\b/)
  if (dashIdx >= 0) markers.push(dashIdx)
  const bracketIdx = s.search(/[([{]/)
  if (bracketIdx >= 0) markers.push(bracketIdx)

  const cut = markers.length ? Math.min(...markers) : s.length
  let title = s.slice(0, cut).trim()
  title = title.replace(/[-–:|]+\s*$/, '').trim()
  if (!title) title = s.trim()

  return { title, year, season, episode }
}
