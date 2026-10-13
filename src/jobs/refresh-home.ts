import { refreshTrendingCatalog } from '../modules/catalog/trending'
import { and, eq, inArray, isNull } from 'drizzle-orm'
import { db } from '../db'
import { contents, metadata_cache } from '../types'
import { enrichContent } from '../modules/enrichment'

async function enrichCurrentRankings(): Promise<number> {
  const lists = await db.select({ response: metadata_cache.response }).from(metadata_cache)
    .where(and(eq(metadata_cache.source, 'trending'), inArray(metadata_cache.lookup_key,
      ['list:movie', 'list:series', 'list:anime'])))
  const ids = lists.flatMap(({ response }) => {
    const items = (response as { items?: { id?: number }[] } | null)?.items
    return Array.isArray(items) ? items.flatMap((item) =>
      typeof item.id === 'number' && Number.isInteger(item.id) && item.id > 0 ? [item.id] : [],
    ) : []
  })
  if (!ids.length) return 0
  const pending = await db.select().from(contents).where(and(
    inArray(contents.id, ids), isNull(contents.enriched_at), isNull(contents.canonical_content_id),
  ))
  let enriched = 0
  for (const item of pending) if (await enrichContent(item)) enriched++
  return enriched
}

// Also usable separately, without waiting for torrent scraping or gap filling.
if (import.meta.main) {
  try {
    await refreshTrendingCatalog()
    console.log(`[home] ${await enrichCurrentRankings()} current contents enriched`)
    process.exit(0)
  } catch (error) {
    console.error('[home] refresh failed:', (error as Error).message)
    process.exit(1)
  }
}
