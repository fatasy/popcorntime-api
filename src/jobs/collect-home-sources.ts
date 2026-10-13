import { sql } from 'drizzle-orm'
import { db } from '../db'
import { metadata_cache } from '../types'
import { collectTorrentsByQuery, type Category } from '../modules/collection'

/** Rankings can introduce existing IDs before discovery. Search their missing sources too. */
export async function collectHomeSources(limit = 6): Promise<number> {
  const candidates = await db.execute(sql`
    SELECT DISTINCT ON (c.id) c.id, c.type, c.title, c.original_title, attempt.cached_at, ranked.position
    FROM metadata_cache mc
    CROSS JOIN LATERAL jsonb_array_elements(
      CASE WHEN jsonb_typeof(mc.response->'items') = 'array'
        THEN mc.response->'items' ELSE '[]'::jsonb END
    ) WITH ORDINALITY AS ranked(item, position)
    JOIN contents c ON c.id::text = ranked.item->>'id'
    LEFT JOIN metadata_cache attempt ON attempt.source = 'home-source-collection'
      AND attempt.lookup_key = c.id::text
    WHERE mc.source = 'trending' AND mc.lookup_key IN ('list:movie', 'list:series')
      AND mc.cached_at > now() - interval '7 days'
      AND c.canonical_content_id IS NULL
      AND c.release_date <= current_date
      AND NOT EXISTS (SELECT 1 FROM content_torrents ct WHERE ct.content_id = c.id)
      AND (attempt.cached_at IS NULL OR attempt.cached_at < now() - interval '6 hours')
    ORDER BY c.id, ranked.position
  `)
  const selected = [...candidates].sort((a, b) =>
    (a.cached_at ? new Date(String(a.cached_at)).getTime() : 0) -
    (b.cached_at ? new Date(String(b.cached_at)).getTime() : 0) || Number(a.position) - Number(b.position),
  ).slice(0, limit)
  let added = 0
  for (const item of selected) {
    // Original titles are the release names searched by torrent providers.
    const query = String(item.original_title || item.title)
    added += await collectTorrentsByQuery(query, item.type === 'movie' ? 'movies' : 'series' as Category)
    await db.insert(metadata_cache).values({
      source: 'home-source-collection', lookup_key: String(item.id), response: { query },
    }).onConflictDoUpdate({
      target: [metadata_cache.source, metadata_cache.lookup_key],
      set: { response: { query }, cached_at: sql`now()` },
    })
  }
  console.log(`[home-sources] ${selected.length} current titles searched, ${added} torrents added`)
  return added
}
