import { and, eq, isNotNull, gt, desc } from 'drizzle-orm'
import { db } from '../../db'
import { contents, torrents, content_torrents } from '../../types'
import type { RawTorrent } from '../../lib/parse'
import { searchSolidTorrents } from './sources/solidtorrents'
import { extractQualityLabel } from '../torrent/quality'

// Rank a torrent title's quality on a numeric scale so "better" is well-defined.
// 1080p+ with a proper source (BluRay/WEB-DL) is the target (>= 50). CAM/TS is
// the floor (~10) — exactly the state a recent theatrical movie is squat in.
function qualityRank(title: string): number {
  const low = /\b(cam|hdcam|ts|telesync|telecine|\btc\b)\b/i
  const hi = /\b(2160p|4k|uhd)\b/i
  const hd = /\b1080p\b/i
  const hd720 = /\b720p\b/i
  const sd = /\b480p\b/i

  let r = 20 // Unknown
  if (hi.test(title)) r = 60
  else if (hd.test(title)) r = 50
  else if (hd720.test(title)) r = 40
  else if (sd.test(title)) r = 30
  if (low.test(title) && r > 10) r = 10

  if (/\b(blu-?ray|brrip|bdrip|remux)\b/i.test(title)) r += 10
  else if (/\bweb-?dl\b/i.test(title)) r += 10
  else if (/\bwebrip\b/i.test(title)) r += 4
  if (hi.test(title) && /\b(hdr|dv|dolby vision)\b/i.test(title)) r += 2
  return r
}

const GOOD_RANK = 50 // 1080p+ WEB-DL/BluRay: a real, watchable source
const RECENT_WINDOW_MS = 120 * 24 * 60 * 60 * 1000 // 120 days
const QUERY_SUFFIXES = ['1080p', '2160p']

interface UpgradeResult {
  contentId: number
  title: string
  addedTitle: string | null
  quality: string | null
}

/**
 * Upgrade source quality for recent movies stuck with only CAM/TS/HDRip.
 *
 * A movie in theaters only has low-quality torrents; when the digital release
 * (WEB-DL/BluRay 1080p/2160p) lands, nothing in the normal pipeline fetches the
 * better source. This scans recently-enriched movies that still lack a 1080p+
 * source and adds the best SolidTorrents find, promoting it to primary.
 */
export async function upgradeRecentMovieQuality(limit = 10): Promise<UpgradeResult[]> {
  const since = new Date(Date.now() - RECENT_WINDOW_MS)
  const candidates = await db
    .select({ id: contents.id, title: contents.title, year: contents.year })
    .from(contents)
    .where(
      and(
        eq(contents.type, 'movie'),
        isNotNull(contents.enriched_at),
        isNotNull(contents.tmdb_id),
        gt(contents.created_at, since),
      ),
    )
    .orderBy(desc(contents.id))
    .limit(limit * 2)

  const results: UpgradeResult[] = []
  let processed = 0

  for (const movie of candidates) {
    if (processed >= limit) break

    // Current best quality already in the catalog for this movie.
    const links = await db
      .select({ title: torrents.title })
      .from(content_torrents)
      .innerJoin(torrents, and(eq(torrents.id, content_torrents.torrent_id)))
      .where(eq(content_torrents.content_id, movie.id))
    const currentBest = links.reduce((m, l) => Math.max(m, qualityRank(l.title ?? '')), 0)
    if (currentBest >= GOOD_RANK) continue // already has a real 1080p+ source
    processed++

    // Find high-quality SolidTorrents releases.
    const query = `${movie.title} ${movie.year ?? ''}`.trim()
    const found: RawTorrent[] = []
    for (const suffix of QUERY_SUFFIXES) {
      try {
        const res = await searchSolidTorrents(`${query} ${suffix}`, 30)
        for (const t of res) {
          const title = t.title ?? ''
          if (/\b\.(exe|scr)\b/i.test(title)) continue // fake video files
          if ((t.seeds ?? 0) < 1) continue
          if (qualityRank(title) >= GOOD_RANK) found.push(t)
        }
      } catch (err) {
        console.warn(`[quality] SolidTorrents search failed for "${query} ${suffix}":`, (err as Error).message)
      }
    }
    if (found.length === 0) {
      console.log(`[quality] "${movie.title}": no 1080p+ source found`)
      continue
    }

    found.sort(
      (a, b) =>
        qualityRank(b.title) - qualityRank(a.title) ||
        (b.seeds ?? 0) - (a.seeds ?? 0),
    )
    const best = found[0]!
    const bestRank = qualityRank(best.title)
    if (bestRank <= currentBest) continue

    // Persist the torrent (dedupe by hash) and link it to the movie.
    const existing = await db
      .select({ id: torrents.id })
      .from(torrents)
      .where(eq(torrents.hash, best.hash))
      .limit(1)
    let torrentId = existing[0]?.id
    if (torrentId == null) {
      const inserted = await db
        .insert(torrents)
        .values({
          source: best.source,
          hash: best.hash,
          title: best.title.slice(0, 512),
          magnet_link: best.magnet_link,
          seeds: best.seeds,
          leechers: best.leechers,
          size_bytes: best.size_bytes ?? null,
          uploader: best.uploader ? best.uploader.slice(0, 128) : null,
          category: 'movies',
          published_at: best.published_at ?? new Date(),
          collected_at: new Date(),
          last_seen_at: new Date(),
        })
        .onConflictDoNothing({ target: torrents.hash })
        .returning({ id: torrents.id })
      torrentId = inserted[0]?.id
    }
    if (torrentId == null) continue

    const alreadyLinked = await db
      .select({ id: content_torrents.content_id })
      .from(content_torrents)
      .where(and(eq(content_torrents.content_id, movie.id), eq(content_torrents.torrent_id, torrentId)))
      .limit(1)
    if (alreadyLinked.length === 0) {
      await db.insert(content_torrents).values({
        content_id: movie.id,
        torrent_id: torrentId,
        is_primary: false,
        season: null,
        episode: null,
        added_at: new Date(),
      })
    }

    // Promote to primary if it's better than the current primary.
    const primaryRows = await db
      .select({ title: torrents.title })
      .from(content_torrents)
      .innerJoin(torrents, and(eq(torrents.id, content_torrents.torrent_id)))
      .where(and(eq(content_torrents.content_id, movie.id), eq(content_torrents.is_primary, true)))
    const currentPrimaryRank = primaryRows.reduce((m, l) => Math.max(m, qualityRank(l.title ?? '')), 0)
    if (bestRank > currentPrimaryRank) {
      await db
        .update(content_torrents)
        .set({ is_primary: false })
        .where(eq(content_torrents.content_id, movie.id))
      await db
        .update(content_torrents)
        .set({ is_primary: true })
        .where(and(eq(content_torrents.content_id, movie.id), eq(content_torrents.torrent_id, torrentId)))
    }

    results.push({
      contentId: movie.id,
      title: movie.title,
      addedTitle: best.title,
      quality: extractQualityLabel(best.title),
    })
    console.log(
      `[quality] "${movie.title}": upgraded → ${extractQualityLabel(best.title)} "${best.title.slice(0, 80)}" (${best.seeds}s)`,
    )
  }

  return results
}