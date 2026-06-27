import { and, eq, isNotNull, ne } from 'drizzle-orm'
import { db } from '../../db'
import { contents, content_torrents } from '../../types'

/**
 * Merge series-type contents that share the same tmdb_id.
 *
 * For each tmdb_id that has 2+ series contents:
 *   - Pick the one with the most/best metadata (poster, synopsis, rating, cast)
 *     as the canonical content.
 *   - Move all content_torrents rows from the others to the canonical one,
 *     preserving season/episode stored on content_torrents.
 *   - Delete the orphaned content rows.
 *
 * Returns the number of content rows deleted.
 */
export async function mergeByTmdbId(): Promise<number> {
  // Find all series-type contents that have a tmdb_id
  const series = await db
    .select()
    .from(contents)
    .where(and(eq(contents.type, 'series'), isNotNull(contents.tmdb_id)))

  // Group by tmdb_id
  const byTmdb = new Map<number, typeof series>()
  for (const c of series) {
    const tid = c.tmdb_id!
    if (!byTmdb.has(tid)) byTmdb.set(tid, [])
    byTmdb.get(tid)!.push(c)
  }

  let deleted = 0
  let merged = 0

  for (const [tmdbId, group] of byTmdb) {
    if (group.length < 2) continue

    // Score each content by metadata completeness
    const scored = group.map((c) => {
      let score = 0
      if (c.poster_url) score += 3
      if (c.synopsis) score += 3
      if (c.rating) score += 2
      if (c.cast_members && c.cast_members.length > 0) score += 2
      if (c.backdrop_url) score += 1
      if (c.genres && c.genres.length > 0) score += 1
      if (c.director) score += 1
      // Prefer enriched ones
      if (c.enriched_at) score += 1
      return { content: c, score }
    })

    // Sort: highest score first, then most recently updated as tiebreaker
    scored.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score
      const aUpd = a.content.updated_at?.getTime() ?? 0
      const bUpd = b.content.updated_at?.getTime() ?? 0
      return bUpd - aUpd
    })

    const canonical = scored[0]!.content
    const orphans = scored.slice(1)

    const canonicalTitle = canonical.title

    for (const orphan of orphans) {
      // Move content_torrents to canonical, preserving season/episode
      // First get all content_torrents for the orphan
      const links = await db
        .select()
        .from(content_torrents)
        .where(eq(content_torrents.content_id, orphan.content.id))

      for (const link of links) {
        await db
          .insert(content_torrents)
          .values({
            content_id: canonical.id,
            torrent_id: link.torrent_id,
            is_primary: false, // will be recomputed if needed
            season: link.season,
            episode: link.episode,
          })
          .onConflictDoNothing()
      }

      // Delete orphan content_torrents
      await db
        .delete(content_torrents)
        .where(eq(content_torrents.content_id, orphan.content.id))

      // Delete the orphan content
      await db.delete(contents).where(eq(contents.id, orphan.content.id))

      deleted++
      merged += links.length
    }

    console.log(
      `[merge] "${canonicalTitle}" (tmdb:${tmdbId}): ${merged} merged, ${deleted} deleted`,
    )
  }

  return deleted
}
