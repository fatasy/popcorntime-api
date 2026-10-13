import { and, asc, eq, inArray, isNull, or, sql } from 'drizzle-orm'
import { db } from '../db'
import { contents, metadata_cache } from '../types'
import { mapTmdb } from '../modules/enrichment'
import { discoverDorama, getTV } from '../modules/enrichment/tmdb'
import { doramaGenres, preserveDoramaGenres } from '../modules/catalog/dorama'
import { preserveChineseFantasyGenres } from '../modules/catalog/chinese-fantasy'

const SOURCE = 'dorama'
const LOOKUP = 'catalog:v1'
const REFRESH_MS = 6 * 60 * 60_000
const categoryGenres = (current: string[] | null, next: string[] | null) =>
  preserveDoramaGenres(current, preserveChineseFantasyGenres(current, next))

/** Discover metadata without blocking the catalog on torrent searches. */
export async function syncDoramaCatalog(force = false): Promise<{ series: number; created: number }> {
  const [saved] = await db.select().from(metadata_cache)
    .where(and(eq(metadata_cache.source, SOURCE), eq(metadata_cache.lookup_key, LOOKUP))).limit(1)
  if (!force && saved?.cached_at && Date.now() - saved.cached_at.getTime() < REFRESH_MS) {
    return { series: 0, created: 0 }
  }
  const candidates = await discoverDorama()
  if (!candidates.length) throw new Error('Dorama provider returned no titles')
  const result = { series: 0, created: 0 }
  const ids: number[] = []
  let failures = 0
  for (const item of candidates) {
    try {
      const details = await getTV(item.id)
      if (!doramaGenres(details).length) continue
      const mapped = mapTmdb(details, 'tv')
      if (!mapped.title) continue
      const [byId] = await db.select().from(contents).where(and(
        eq(contents.tmdb_id, item.id), inArray(contents.type, ['anime', 'series']),
      )).orderBy(sql`(select count(*) from content_torrents ct where ct.content_id = ${contents.id}) desc`, asc(contents.id)).limit(1)
      const [byTitle] = byId ? [] : await db.select().from(contents).where(and(
        eq(contents.type, 'series'), isNull(contents.tmdb_id), isNull(contents.canonical_content_id),
        or(eq(contents.title, mapped.title), mapped.original_title ? eq(contents.original_title, mapped.original_title) : undefined),
        mapped.year != null ? eq(contents.year, mapped.year) : sql`false`,
      )).orderBy(asc(contents.id)).limit(1)
      const existing = byId ?? byTitle
      if (existing?.canonical_content_id != null) {
        const [canonical] = await db.select().from(contents).where(eq(contents.id, existing.canonical_content_id)).limit(1)
        if (canonical?.type === 'series') {
          await db.update(contents).set({ genres: categoryGenres(canonical.genres, mapped.genres ?? null), updated_at: new Date() })
            .where(eq(contents.id, canonical.id))
          ids.push(canonical.id); result.series++
        }
        continue
      }
      const values = { ...mapped, type: 'series', title: mapped.title,
        genres: categoryGenres(existing?.genres ?? null, mapped.genres ?? null),
        imdb_id: mapped.imdb_id ?? existing?.imdb_id ?? null,
        enriched_at: new Date(), updated_at: new Date() }
      if (existing) {
        if (existing.synopsis_raw != null && values.synopsis) {
          values.synopsis_raw = values.synopsis; values.synopsis = existing.synopsis
        }
        await db.update(contents).set(values).where(eq(contents.id, existing.id))
        ids.push(existing.id)
      } else {
        const [row] = await db.insert(contents).values(values).returning({ id: contents.id })
        if (row) { ids.push(row.id); result.created++ }
      }
      result.series++
    } catch (error) {
      failures++
      console.warn(`[dorama] TV ${item.id}:`, (error as Error).message)
    }
  }
  if (failures) throw new Error(`${failures} dorama titles could not be synchronized; saved titles remain available`)
  if (!ids.length) throw new Error('No dorama titles passed metadata validation')
  await db.insert(metadata_cache).values({ source: SOURCE, lookup_key: LOOKUP, response: { ids: [...new Set(ids)], ...result } })
    .onConflictDoUpdate({ target: [metadata_cache.source, metadata_cache.lookup_key],
      set: { response: { ids: [...new Set(ids)], ...result }, cached_at: sql`now()` } })
  console.log(`[dorama] ${result.series} series, ${result.created} new titles`)
  return result
}

if (import.meta.main) {
  try { await syncDoramaCatalog(process.argv.includes('--force')); process.exit(0) }
  catch (error) { console.error('[dorama]', (error as Error).message); process.exit(1) }
}
