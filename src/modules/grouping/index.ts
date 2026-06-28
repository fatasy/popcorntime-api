import { and, eq, isNull, ilike } from 'drizzle-orm'
import { db } from '../../db'
import { contents, content_torrents, torrents } from '../../types'
import { normalizeTitle, parseRelease } from '../../lib/parse'

type ContentType = 'movie' | 'series' | 'anime'

// Torrent category label ('movies'/'series'/'anime') -> content type.
function typeForCategory(cat?: string | null): ContentType {
  if (cat === 'series') return 'series'
  if (cat === 'anime') return 'anime'
  return 'movie'
}

/**
 * Match ungrouped torrents to contents by normalized title.
 *  - movie  : title + year
 *  - series : title only (season stored on content_torrents, merged later)
 *  - anime  : title + episode
 * Creates a new content when no match is found, links the torrent, and marks
 * the highest-seeded torrent of each touched content as `is_primary`.
 */
export async function groupUngrouped(
  limit = 200,
): Promise<{ matched: number; created: number }> {
  // Ungrouped = torrents with no row in content_torrents.
  const rows = await db
    .select({ t: torrents })
    .from(torrents)
    .leftJoin(content_torrents, eq(content_torrents.torrent_id, torrents.id))
    .where(isNull(content_torrents.torrent_id))
    .limit(limit)
  const ungrouped = rows.map((r) => r.t)

  let matched = 0
  let created = 0
  const touched = new Set<number>()

  for (const tor of ungrouped) {
    try {
      const parsed = parseRelease(tor.title)
      const type = typeForCategory(tor.category)
      const norm = normalizeTitle(parsed.title)
      if (!norm) continue

      // Narrow candidates in SQL by the type-specific key, then compare
      // normalized titles in JS.
      const conds = [eq(contents.type, type)]
      let hasNarrowingFilter = false
      if (parsed.year != null) { conds.push(eq(contents.year, parsed.year)); hasNarrowingFilter = true }
      if (type === 'anime' && parsed.episode != null) {
        // For anime, narrow by title prefix (normalizeTitle can't be pushed to SQL, use ilike)
        const titlePrefix = norm.substring(0, 8)
        if (titlePrefix.length >= 4) {
          conds.push(ilike(contents.title, `${titlePrefix}%`))
          hasNarrowingFilter = true
        }
      }

      // If we have no year, no episode/season → too risky to match (would scan ALL contents of that type).
      // Skip matching entirely and create a new content. Enrichment + merge will fix duplicates later.
      if (!hasNarrowingFilter) {
        const inserted = await db
          .insert(contents)
          .values({
            type,
            title: parsed.title.slice(0, 512),
            year: parsed.year ?? null,
            season: null,
            episode: null,
          })
          .returning({ id: contents.id })
        await db
          .insert(content_torrents)
          .values({
            content_id: inserted[0]!.id,
            torrent_id: tor.id,
            is_primary: false,
            season: parsed.season ?? null,
            episode: parsed.episode ?? null,
          })
          .onConflictDoNothing()
        created++
        touched.add(inserted[0]!.id)
        continue
      }

      const candidates = await db
        .select()
        .from(contents)
        .where(conds.length > 1 ? and(...conds) : conds[0])

      const match = candidates.find(
        (c) =>
          normalizeTitle(c.title) === norm ||
          (c.original_title != null && normalizeTitle(c.original_title) === norm),
      )

      let contentId: number
      if (match) {
        contentId = match.id
        matched++
      } else {
        const inserted = await db
          .insert(contents)
          .values({
            type,
            title: parsed.title.slice(0, 512),
            year: parsed.year ?? null,
            // No longer set season for series — merged later by tmdb_id.
            season: type === 'anime' ? null : null,
            episode: type === 'anime' ? parsed.episode ?? null : null,
          })
          .returning({ id: contents.id })
        contentId = inserted[0]!.id
        created++
      }

      await db
        .insert(content_torrents)
        .values({
          content_id: contentId,
          torrent_id: tor.id,
          is_primary: false,
          season: parsed.season ?? null,
          episode: parsed.episode ?? null,
        })
        .onConflictDoNothing()

      touched.add(contentId)
    } catch (err) {
      console.warn(`[group] torrent ${tor.id} ("${tor.title}") failed:`, (err as Error).message)
    }
  }

  // Recompute primary torrent for every content we touched.
  for (const contentId of touched) {
    try {
      await markPrimary(contentId)
    } catch (err) {
      console.warn(`[group] markPrimary(${contentId}) failed:`, (err as Error).message)
    }
  }

  console.log(`[group] matched ${matched}, created ${created} content(s)`)
  return { matched, created }
}

/** Set is_primary on the highest-seeded torrent linked to a content. */
async function markPrimary(contentId: number): Promise<void> {
  const links = await db
    .select({ torrent_id: content_torrents.torrent_id, seeds: torrents.seeds })
    .from(content_torrents)
    .innerJoin(torrents, eq(torrents.id, content_torrents.torrent_id))
    .where(eq(content_torrents.content_id, contentId))
  if (links.length === 0) return

  let best = links[0]!
  for (const link of links) {
    if ((link.seeds ?? 0) > (best.seeds ?? 0)) best = link
  }

  await db
    .update(content_torrents)
    .set({ is_primary: false })
    .where(eq(content_torrents.content_id, contentId))
  await db
    .update(content_torrents)
    .set({ is_primary: true })
    .where(
      and(
        eq(content_torrents.content_id, contentId),
        eq(content_torrents.torrent_id, best.torrent_id),
      ),
    )
}
