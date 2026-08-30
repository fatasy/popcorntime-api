import { and, eq, isNotNull, sql, inArray } from 'drizzle-orm'
import { db } from '../../db'
import { contents, content_torrents } from '../../types'

/**
 * Merge contents that share the same tmdb_id — covers `series` AND `movie`.
 *
 * Movies were added after 151 duplicate movie rows accumulated (71 groups,
 * worst: "Terra Nova" ×11): the discovery/grouping paths can create a second
 * row with the same tmdb_id and nothing ever consolidated them. Grouping key
 * is (type, tmdb_id) because TMDB movie and tv ids live in separate namespaces.
 *
 * For each (type, tmdb_id) that has 2+ contents:
 *   - Pick the canonical: most linked torrents first (so we keep the filled
 *     entry), then metadata completeness, then most recently updated.
 *   - Move all content_torrents rows from the others to the canonical one,
 *     preserving season/episode.
 *   - Delete the orphaned content rows.
 *
 * Returns the number of content rows deleted.
 */
export async function mergeByTmdbId(): Promise<number> {
  // Find all series/movie contents that have a tmdb_id
  const series = await db
    .select()
    .from(contents)
    .where(and(inArray(contents.type, ['series', 'movie']), isNotNull(contents.tmdb_id)))

  // Group by (type, tmdb_id)
  const byTmdb = new Map<string, typeof series>()
  for (const c of series) {
    const key = `${c.type}:${c.tmdb_id!}`
    if (!byTmdb.has(key)) byTmdb.set(key, [])
    byTmdb.get(key)!.push(c)
  }

  let deleted = 0
  let merged = 0

  for (const [key, group] of byTmdb) {
    if (group.length < 2) continue

    // Score each content: existing torrents strongly favored, then metadata
    const scored = await Promise.all(
      group.map(async (c) => {
        const cnt = await db
          .select({ n: sql<number>`count(*)::int` })
          .from(content_torrents)
          .where(eq(content_torrents.content_id, c.id))
        const n = cnt[0]?.n ?? 0
        let score = n * 5 // any existing content strongly favored
        if (c.poster_url) score += 3
        if (c.synopsis) score += 3
        if (c.rating) score += 2
        if (c.cast_members && c.cast_members.length > 0) score += 2
        if (c.backdrop_url) score += 1
        if (c.genres && c.genres.length > 0) score += 1
        if (c.director) score += 1
        if (c.enriched_at) score += 1
        return { content: c, score, links: n }
      }),
    )

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
            is_primary: link.is_primary ?? false,
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
      `[merge] "${canonicalTitle}" (${key}): ${merged} merged, ${deleted} deleted`,
    )
  }

  return deleted
}

/**
 * Merge anime-type contents that share the same mal_id.
 *
 * The vast majority of anime are keyed by MAL id (Jikan) and have NO tmdb_id,
 * so `mergeByTmdbId()` never consolidates them. That left ~392 duplicate anime
 * rows (223 distinct mal_id in 615 rows) — most of them empty catalog entries
 * that never receive episodes because fill-gaps scans per-content.
 *
 * For each mal_id with 2+ anime contents:
 *   - Pick the canonical row: prefer one that already has content_torrents
 *     (so we keep the filled entry), then most enriched/synopsis/poster.
 *   - Move all content_torrents rows from the others to the canonical one,
 *     preserving season/episode/is_primary.
 *   - Delete the orphaned content rows.
 *
 * Returns the number of content rows deleted.
 */
export async function mergeByMalId(): Promise<number> {
  const anime = await db
    .select()
    .from(contents)
    .where(and(eq(contents.type, 'anime'), isNotNull(contents.mal_id)))

  const byMal = new Map<number, typeof anime>()
  for (const c of anime) {
    const mid = c.mal_id!
    if (!byMal.has(mid)) byMal.set(mid, [])
    byMal.get(mid)!.push(c)
  }

  let deleted = 0
  let merged = 0

  for (const [malId, group] of byMal) {
    if (group.length < 2) continue

    // Prefer the row that already has linked torrents; then richer metadata.
    const scored = await Promise.all(
      group.map(async (c) => {
        const cnt = await db
          .select({ n: sql<number>`count(*)::int` })
          .from(content_torrents)
          .where(eq(content_torrents.content_id, c.id))
        const n = cnt[0]?.n ?? 0
        let score = n * 5 // any existing content strongly favored
        if (c.enriched_at) score += 3
        if (c.synopsis) score += 2
        if (c.poster_url) score += 2
        if (c.rating) score += 1
        if (c.mal_id) score += 1
        if (c.tmdb_id) score += 1
        return { content: c, score, links: n }
      }),
    )

    scored.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score
      const aUpd = a.content.updated_at?.getTime() ?? 0
      const bUpd = b.content.updated_at?.getTime() ?? 0
      return bUpd - aUpd
    })

    const canonical = scored[0]!.content
    const orphans = scored.slice(1)

    for (const orphan of orphans) {
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
            is_primary: link.is_primary ?? false,
            season: link.season,
            episode: link.episode,
          })
          .onConflictDoNothing()
      }

      await db
        .delete(content_torrents)
        .where(eq(content_torrents.content_id, orphan.content.id))

      await db.delete(contents).where(eq(contents.id, orphan.content.id))

      deleted++
      merged += links.length
    }

    console.log(
      `[merge] "${canonical.title}" (mal:${malId}): ${merged} merged, ${deleted} deleted`,
    )
  }

  return deleted
}
