import { and, eq, sql } from 'drizzle-orm'
import { db } from '../../db'
import { metadata_cache } from '../../types'
import { BackgroundRefreshQueue, readExternalCatalog } from '../../lib/background-refresh'
import { getTVAlternativeTitles } from '../enrichment/tmdb'
import { expandAnimeTitleAliases, providerAnimeAliases } from './title-aliases'

const refreshes = new BackgroundRefreshQueue(2, 5 * 60_000)

export async function animeCatalogTitles(content: {
  title: string; original_title?: string | null; tmdb_id?: number | null
}): Promise<string[]> {
  const local = expandAnimeTitleAliases([content.title, content.original_title])
  if (!content.tmdb_id) return local
  const lookup = `tv:${content.tmdb_id}:titles`
  const external = await readExternalCatalog({
    key: lookup, queue: refreshes, ttlMs: 7 * 86400_000, coldWaitMs: 1200,
    read: async () => {
      const [row] = await db.select().from(metadata_cache).where(and(
        eq(metadata_cache.source, 'tmdb'), eq(metadata_cache.lookup_key, lookup),
      )).limit(1)
      return row && Array.isArray(row.response) ? { value: row.response as string[], cachedAt: row.cached_at ?? new Date(0) } : null
    },
    refresh: async () => {
      const aliases = providerAnimeAliases(await getTVAlternativeTitles(content.tmdb_id!))
      await db.insert(metadata_cache).values({ source: 'tmdb', lookup_key: lookup, response: aliases })
        .onConflictDoUpdate({ target: [metadata_cache.source, metadata_cache.lookup_key],
          set: { response: aliases, cached_at: sql`now()` } })
      return aliases
    },
  })
  return expandAnimeTitleAliases([...local, ...(external ?? [])])
}
