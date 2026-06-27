import { getTV } from '../enrichment/tmdb'

// ─── Types ────────────────────────────────────────────────────────────────

export interface SeasonCoverage {
  type: 'full' | 'partial' | 'single' | 'unknown'
  seasons: number[]       // sorted ascending
  confidence: 'tmdb' | 'heuristic'
}

// ─── Cache ────────────────────────────────────────────────────────────────

const coverageCache = new Map<string, SeasonCoverage>()

// ─── Public API ───────────────────────────────────────────────────────────

/**
 * Classify how many seasons a torrent title covers.
 *
 * Layer 1 (TMDB): when tmdbId is available, fetch season_count from TMDB
 *   and compare against numbers extracted from the title.
 * Layer 2 (LLM fallback stub): returns 'unknown' for now.
 * Layer 3 (heuristic): regex-based extraction when TMDB is unavailable.
 */
export async function classifySeasonCoverage(
  torrentTitle: string,
  tmdbId: number | null,
): Promise<SeasonCoverage> {
  // Normalize title for consistent cache key
  const cacheKey = `${tmdbId ?? 'none'}::${torrentTitle.toLowerCase().trim()}`
  const cached = coverageCache.get(cacheKey)
  if (cached) return cached

  // ── Layer 1: TMDB-informed ──────────────────────────────────────────
  if (tmdbId != null) {
    try {
      const tv = await getTV(tmdbId)
      const seasonCount = tv.number_of_seasons ?? tv.seasons?.length ?? 0

      if (seasonCount > 0) {
        const numbers = extractSeasonNumbers(torrentTitle)
        const coverage = classifyFromNumbers(numbers, seasonCount)

        if (coverage.type !== 'unknown') {
          coverageCache.set(cacheKey, coverage)
          return coverage
        }
      }
    } catch (err) {
      console.warn(
        `[season-coverage] TMDB fetch failed for tmdb:${tmdbId}:`,
        (err as Error).message,
      )
      // Fall through to heuristic
    }
  }

  // ── Layer 3: Heuristic ──────────────────────────────────────────────
  const coverage = heuristicCoverage(torrentTitle)
  coverageCache.set(cacheKey, coverage)
  return coverage
}

// ─── Number extraction ────────────────────────────────────────────────────

/**
 * Extract all season numbers from a torrent title by finding
 * numbers that appear near the word "season" or "temporada".
 *
 * Handles patterns like:
 *   "Season 1 2 3 4 5 6 7 8"
 *   "Season 1-8"
 *   "Seasons 1 & 2"
 *   "Temporada 1 2 3"
 *   "S01-S08"
 */
function extractSeasonNumbers(title: string): number[] {
  const numbers = new Set<number>()

  // 1. "Season X Y Z ..." or "Temporada X Y Z ..."
  // Find occurrences of season/temporada, then grab numbers in the window
  const seasonWordRegex = /\b(seasons?|temporadas?)\b/gi
  let match: RegExpExecArray | null

  while ((match = seasonWordRegex.exec(title)) !== null) {
    const idx = match.index
    // Look at a window around the match: ~80 chars before to ~200 chars after
    // This is intentionally wide to capture "Season 1 2 3 ... 16" in long titles
    const start = Math.max(0, idx - 30)
    const end = Math.min(title.length, idx + 250)
    const window = title.slice(start, end)

    // Extract ALL standalone numbers from this window
    const numRegex = /\b(\d{1,2})\b/g
    let numMatch: RegExpExecArray | null
    while ((numMatch = numRegex.exec(window)) !== null) {
      const n = parseInt(numMatch[1]!, 10)
      // Reasonable season numbers: 1-99
      if (n >= 1 && n <= 99) {
        numbers.add(n)
      }
    }

    // Also handle range patterns like "Season 1-8" or "Seasons 1-15"
    const rangeRegex = /\b(\d{1,2})\s*[-–]\s*(\d{1,2})\b/g
    let rangeMatch: RegExpExecArray | null
    while ((rangeMatch = rangeRegex.exec(window)) !== null) {
      const from = parseInt(rangeMatch[1]!, 10)
      const to = parseInt(rangeMatch[2]!, 10)
      if (from >= 1 && from <= 99 && to >= from && to <= 99) {
        for (let i = from; i <= to; i++) numbers.add(i)
      }
    }
  }

  // 2. "S01"-"S99" patterns (compact notation often used for multi-season)
  const sPatternRegex = /\bS(\d{2})\b/gi
  while ((match = sPatternRegex.exec(title)) !== null) {
    const n = parseInt(match[1]!, 10)
    if (n >= 1 && n <= 99) numbers.add(n)
  }

  // 3. Also check for "COMPLETE" or "Complete Series" — these cover all seasons
  // We only flag them; actual season count comes from TMDB

  return Array.from(numbers).sort((a, b) => a - b)
}

// ─── Classification helpers ───────────────────────────────────────────────

/**
 * Given extracted numbers and TMDB season_count, classify the coverage.
 */
function classifyFromNumbers(
  extracted: number[],
  seasonCount: number,
): SeasonCoverage {
  if (extracted.length === 0) {
    return { type: 'unknown', seasons: [], confidence: 'heuristic' }
  }

  const expectedSeasons = Array.from({ length: seasonCount }, (_, i) => i + 1)

  // Check if the extracted numbers cover all expected seasons
  const coversAll = expectedSeasons.every((s) => extracted.includes(s))

  if (coversAll && extracted.length >= seasonCount) {
    return {
      type: 'full',
      seasons: expectedSeasons,
      confidence: 'tmdb',
    }
  }

  if (extracted.length > 1) {
    // Could be partial or could be full but with gaps in extraction
    // If we have most seasons, treat as full
    const coverageRatio = extracted.filter((s) => s <= seasonCount).length / seasonCount
    if (coverageRatio >= 0.9) {
      return {
        type: 'full',
        seasons: expectedSeasons,
        confidence: 'tmdb',
      }
    }

    if (extracted.length >= 2) {
      return {
        type: 'partial',
        seasons: extracted.filter((s) => s <= seasonCount),
        confidence: 'tmdb',
      }
    }
  }

  // Single number
  if (extracted.length === 1) {
    return {
      type: 'single',
      seasons: [extracted[0]!],
      confidence: 'tmdb',
    }
  }

  return { type: 'unknown', seasons: [], confidence: 'heuristic' }
}

// ─── Heuristic (no TMDB) ──────────────────────────────────────────────────

/**
 * Best-effort classification without TMDB data.
 */
function heuristicCoverage(title: string): SeasonCoverage {
  const numbers = extractSeasonNumbers(title)

  if (numbers.length > 1) {
    // Check for consecutive range
    const isConsecutive = numbers.every((n, i) => i === 0 || n === numbers[i - 1]! + 1)
    if (isConsecutive) {
      // It's a multi-season pack covering a range, but we don't know if it's "full"
      return {
        type: 'partial',
        seasons: numbers,
        confidence: 'heuristic',
      }
    }
    // Non-consecutive numbers — likely partial
    return {
      type: 'partial',
      seasons: numbers,
      confidence: 'heuristic',
    }
  }

  if (numbers.length === 1) {
    return {
      type: 'single',
      seasons: [numbers[0]!],
      confidence: 'heuristic',
    }
  }

  // Check for "Complete" keyword — without TMDB we can't know the count
  if (/\bcomplete\b/i.test(title)) {
    return {
      type: 'unknown',
      seasons: [],
      confidence: 'heuristic',
    }
  }

  return { type: 'unknown', seasons: [], confidence: 'heuristic' }
}

// ─── Utility ──────────────────────────────────────────────────────────────

/** Clear the in-memory cache (useful for testing). */
export function clearCoverageCache(): void {
  coverageCache.clear()
}
