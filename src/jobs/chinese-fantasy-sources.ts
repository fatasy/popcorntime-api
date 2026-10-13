import { and, eq, isNull, or, sql } from 'drizzle-orm'
import { db } from '../db'
import { contents } from '../types'
import { CHINESE_FANTASY_RANK_SQL } from '../modules/catalog/popularity'
import { refreshAnimeHttpSources } from '../modules/streams/service'
import { fillGaps } from '../modules/collection/fill-gaps'

/** One title of each type per ingestion run, rotating attempts with a six-hour cooldown. */
export async function collectChineseFantasySources(): Promise<void> {
  for (const type of ['anime', 'series']) {
    const [item] = await db.select().from(contents).where(and(
      eq(contents.type, type), isNull(contents.canonical_content_id),
      sql`${contents.genres} && ARRAY['Xianxia', 'Wuxia']::text[]`,
      or(isNull(contents.last_gap_fill_at), sql`${contents.last_gap_fill_at} < now() - interval '6 hours'`),
    )).orderBy(sql`${contents.last_gap_fill_at} ASC NULLS FIRST`, sql`${CHINESE_FANTASY_RANK_SQL} DESC`).limit(1)
    if (!item) continue
    try {
      const http = type === 'anime' ? await refreshAnimeHttpSources(item.id) : { sourcesAdded: 0 }
      const filled = await fillGaps(1, { contentId: item.id, maxEpisodesPerContent: 2 })
      console.log(`[chinese-fantasy/sources] ${item.title}: ${http.sourcesAdded} HTTP, ${filled[0]?.torrentsAdded ?? 0} torrents added`)
    } catch (error) {
      console.warn(`[chinese-fantasy/sources] ${item.title}:`, (error as Error).message)
    } finally {
      await db.update(contents).set({ last_gap_fill_at: new Date() }).where(eq(contents.id, item.id))
    }
  }
}

if (import.meta.main) { await collectChineseFantasySources(); process.exit(0) }
