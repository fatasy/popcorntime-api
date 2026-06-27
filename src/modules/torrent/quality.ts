// ─── Types ────────────────────────────────────────────────────────────────

export interface QualityInfo {
  resolution: string | null    // "1080p", "2160p", "720p", "4K", null
  source: string | null        // "BluRay", "WEB-DL", "WEBRip", "HDTV", null
  codec: string | null         // "x264", "x265", "HEVC", null
}

// ─── Regex patterns (ordered: more specific first) ──────────────────────

const RESOLUTIONS: [RegExp, string][] = [
  [/\b2160p\b/i, '2160p'],
  [/\b4k\b/i, '4K'],
  [/\buhd\b/i, '4K'],
  [/\b1080p\b/i, '1080p'],
  [/\b720p\b/i, '720p'],
  [/\b480p\b/i, '480p'],
  [/\b360p\b/i, '360p'],
]

const SOURCES: [RegExp, string][] = [
  [/\bblu-?ray\b/i, 'BluRay'],
  [/\bbrrip\b/i, 'BluRay'],
  [/\bbdrip\b/i, 'BluRay'],
  [/\bremux\b/i, 'BluRay'],
  [/\bweb-?dl\b/i, 'WEB-DL'],
  [/\bwebrip\b/i, 'WEBRip'],
  [/\bhdtv\b/i, 'HDTV'],
  [/\bdvdrip\b/i, 'DVDRip'],
  [/\bhdrip\b/i, 'HDRip'],
  [/\bweb\b/i, 'WEB'],
]

const CODECS: [RegExp, string][] = [
  [/\bx265\b/i, 'x265'],
  [/\bhevc\b/i, 'HEVC'],
  [/\bx264\b/i, 'x264'],
  [/\bh\.?264\b/i, 'H.264'],
  [/\bh\.?265\b/i, 'H.265'],
  [/\bavc\b/i, 'AVC'],
  [/\bav1\b/i, 'AV1'],
  [/\bdv\b/i, 'DV'],           // Dolby Vision
  [/\bhdr10\+?\b/i, 'HDR10+'],
  [/\bhdr10?\b/i, 'HDR10'],
  [/\bhdr\b/i, 'HDR'],
]

// ─── Simple quality label (backward-compatible with parse.ts extractQuality) ──

/** Extract a simple quality label from text. Returns "1080p", "4K", "720p", "Unknown", etc. */
export function extractQualityLabel(text: string): string {
  for (const [re, label] of RESOLUTIONS) {
    if (re.test(text)) return label
  }
  return 'Unknown'
}

// ─── Full quality extraction ─────────────────────────────────────────────

/**
 * Extract full quality info (resolution + source + codec) from a torrent title or filename.
 * Works on both full torrent titles and individual filenames.
 */
export function extractQuality(text: string): QualityInfo {
  let resolution: string | null = null
  let source: string | null = null
  let codec: string | null = null

  for (const [re, label] of RESOLUTIONS) {
    if (re.test(text)) {
      resolution = label
      break
    }
  }

  for (const [re, label] of SOURCES) {
    if (re.test(text)) {
      source = label
      break
    }
  }

  for (const [re, label] of CODECS) {
    if (re.test(text)) {
      codec = label
      break
    }
  }

  return { resolution, source, codec }
}
