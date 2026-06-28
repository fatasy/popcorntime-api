/**
 * Batch file-list enrichment using LimeTorrents scraping.
 * For each unscraped torrent, tries to find the file list on LimeTorrents
 * and stores it in the `file_list` JSONB column + extracts quality.
 */
import { eq, isNull, desc } from 'drizzle-orm'
import { db } from '../../db'
import { torrents } from '../../types'
import { scrapeFileList, extractQualityFromFiles } from '../torrent/scrape-filelist'
import type { LimeTorrentFile } from '../torrent/scrape-filelist'

// Re-export for pipeline use
import { searchSolidTorrents } from '../collection/sources/solidtorrents'

const BATCH_SIZE = 25
const DELAY_BETWEEN_TORRENTS_MS = 1_500

/**
 * Scrape file lists for unscraped torrents, up to `limit`.
 * Only processes torrents where file_list IS NULL.
 */
export async function scrapeFileLists(limit = BATCH_SIZE): Promise<number> {
  const rows = await db
    .select({ id: torrents.id, title: torrents.title, hash: torrents.hash, seeds: torrents.seeds })
    .from(torrents)
    .where(isNull(torrents.file_list))
    .orderBy(desc(torrents.seeds))
    .limit(limit)

  if (rows.length === 0) {
    console.log('[scrape-files] All torrents already have file lists')
    return 0
  }

  console.log(`[scrape-files] Found ${rows.length} torrents without file list. Scraping...`)
  let successCount = 0

  for (const t of rows) {
    try {
      const result = await scrapeFileList(t.title, t.hash)
      if (result && result.files.length > 0) {
        const quality = extractQualityFromFiles(result.files)
        const fileListData = result.files.map((f: LimeTorrentFile) => ({
          name: f.name,
          size: f.size,
          type: f.type,
        }))

        await db
          .update(torrents)
          .set({
            file_list: fileListData as any,
            quality_from_files: quality,
          })
          .where(eq(torrents.id, t.id))

        successCount++
        console.log(
          `[scrape-files] ✓ #${t.id} "${t.title.slice(0, 50)}…" → ${result.files.length} files, quality=${quality || '?'}`
        )
      } else {
        console.log(`[scrape-files] ✗ #${t.id} "${t.title.slice(0, 50)}…" → not found on LimeTorrents`)
      }
    } catch (err) {
      console.warn(`[scrape-files] Error for #${t.id}:`, (err as Error).message)
    }

    if (successCount < rows.length - 1) {
      await new Promise((r) => setTimeout(r, DELAY_BETWEEN_TORRENTS_MS))
    }
  }

  console.log(`[scrape-files] Done: ${successCount}/${rows.length} scraped successfully`)
  return successCount
}

/**
 * Enrich seed counts for EZTV torrents by cross-referencing with SolidTorrents.
 * EZTV always reports seeds=0; SolidTorrents has real swarm data.
 */
export async function enrichEztvSeeds(limit = 50): Promise<number> {
  const rows = await db
    .select({ id: torrents.id, title: torrents.title, hash: torrents.hash, seeds: torrents.seeds })
    .from(torrents)
    .where(eq(torrents.source, 'eztv').and(eq(torrents.seeds, 0)))
    .limit(limit)

  if (rows.length === 0) return 0

  console.log(`[enrich-seeds] Found ${rows.length} EZTV torrents with seeds=0. Enriching...`)
  let updated = 0

  for (const t of rows) {
    try {
      const results = await searchSolidTorrents(t.title, 5)
      const best = results.filter((r) => (r.seeds ?? 0) > 0).sort((a, b) => (b.seeds ?? 0) - (a.seeds ?? 0))[0]
      if (best && (best.seeds ?? 0) > 0) {
        await db
          .update(torrents)
          .set({ seeds: best.seeds, leechers: best.leechers })
          .where(eq(torrents.id, t.id))
        updated++
      }
    } catch (err) {
      // skip
    }
    await new Promise((r) => setTimeout(r, 500))
  }

  console.log(`[enrich-seeds] Updated ${updated}/${rows.length} seed counts`)
  return updated
}
