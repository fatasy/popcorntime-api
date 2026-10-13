import { and, asc, eq, inArray, isNull, or, sql } from 'drizzle-orm'
import { db } from '../db'
import { contents, metadata_cache } from '../types'
import { mapTmdb } from '../modules/enrichment'
import { discoverChineseFantasy, getTV } from '../modules/enrichment/tmdb'
import { chineseFantasyGenres, isChineseAnimation, preserveChineseFantasyGenres } from '../modules/catalog/chinese-fantasy'

const SOURCE = 'chinese-fantasy'
const LOOKUP = 'catalog:v1'
const REFRESH_MS = 6 * 60 * 60_000

/** Metadata discovery stays separate from slow source collection. IDs and existing links are retained. */
export async function syncChineseFantasyCatalog(force = false): Promise<{ anime: number; series: number; created: number }> {
  const [saved] = await db.select().from(metadata_cache)
    .where(and(eq(metadata_cache.source, SOURCE), eq(metadata_cache.lookup_key, LOOKUP))).limit(1)
  if (!force && saved?.cached_at && Date.now() - saved.cached_at.getTime() < REFRESH_MS) {
    return { anime: 0, series: 0, created: 0 }
  }
  const groups = await Promise.all([discoverChineseFantasy(true), discoverChineseFantasy(false)])
  const unique = new Map(groups.flat().map((item) => [item.id, item]))
  if (!unique.size) throw new Error('Chinese fantasy provider returned no titles')
  const result = { anime: 0, series: 0, created: 0 }
  const ids: number[] = []
  let failures = 0
  for (const item of unique.values()) {
    try {
      const details = await getTV(item.id)
      if (!chineseFantasyGenres(details).length) continue
      const type = isChineseAnimation(details) ? 'anime' : 'series'
      const mapped = mapTmdb(details, 'tv')
      if (!mapped.title) continue
      const [byId] = await db.select().from(contents).where(and(
        eq(contents.tmdb_id, item.id), inArray(contents.type, ['anime', 'series']),
      )).orderBy(sql`(select count(*) from content_torrents ct where ct.content_id = ${contents.id}) desc`, asc(contents.id)).limit(1)
      // Exact titles + year only; never relink a title that already has a different TMDB ID.
      const [byTitle] = byId ? [] : await db.select().from(contents).where(and(
        eq(contents.type, type), isNull(contents.tmdb_id), isNull(contents.canonical_content_id),
        or(eq(contents.title, mapped.title), mapped.original_title ? eq(contents.original_title, mapped.original_title) : undefined),
        mapped.year != null ? eq(contents.year, mapped.year) : sql`false`,
      )).orderBy(asc(contents.id)).limit(1)
      const existing = byId ?? byTitle
      if (existing?.canonical_content_id != null) {
        const [canonical] = await db.select().from(contents).where(eq(contents.id, existing.canonical_content_id)).limit(1)
        if (canonical) {
          await db.update(contents).set({ genres: preserveChineseFantasyGenres(canonical.genres, mapped.genres ?? null), updated_at: new Date() })
            .where(eq(contents.id, canonical.id))
          ids.push(canonical.id); result[type]++; continue
        }
      }
      const values = {
        ...mapped, type, title: mapped.title, enriched_at: new Date(), updated_at: new Date(),
        genres: preserveChineseFantasyGenres(existing?.genres ?? null, mapped.genres ?? null),
      }
      if (existing) {
        // Keep translated synopsis, IDs from other providers, and all episode/source links.
        if (existing.synopsis_raw != null && values.synopsis) {
          values.synopsis_raw = values.synopsis; values.synopsis = existing.synopsis
        }
        await db.update(contents).set(values).where(eq(contents.id, existing.id))
        ids.push(existing.id)
      } else {
        const [row] = await db.insert(contents).values(values).returning({ id: contents.id })
        if (row) { ids.push(row.id); result.created++ }
      }
      result[type]++
    } catch (error) {
      failures++
      console.warn(`[chinese-fantasy] TV ${item.id}:`, (error as Error).message)
    }
  }
  if (failures) throw new Error(`${failures} Chinese fantasy titles could not be synchronized; saved titles remain available`)
  if (!ids.length) throw new Error('No Chinese fantasy titles passed keyword validation')
  await db.insert(metadata_cache).values({ source: SOURCE, lookup_key: LOOKUP, response: { ids, ...result } })
    .onConflictDoUpdate({ target: [metadata_cache.source, metadata_cache.lookup_key],
      set: { response: { ids, ...result }, cached_at: sql`now()` } })
  console.log(`[chinese-fantasy] ${result.anime} donghua, ${result.series} series, ${result.created} new titles`)
  return result
}

if (import.meta.main) {
  try { await syncChineseFantasyCatalog(process.argv.includes('--force')); process.exit(0) }
  catch (error) { console.error('[chinese-fantasy]', (error as Error).message); process.exit(1) }
}
