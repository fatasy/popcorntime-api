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

const BATCH_SIZE = 25
const DELAY_BETWEEN_TORRENTS_MS = 1_500

/**
 * Scrape file lists for unscraped torrents, up to `limit`.
 * Only processes torrents where file_list IS NULL.
 */
export async function scrapeFileLists(limit = BATCH_SIZE): Promise<number> {
  // Find torrents without file_list, with seeds > 0
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

    // Rate limiting
    if (successCount < rows.length - 1) {
      await new Promise((r) => setTimeout(r, DELAY_BETWEEN_TORRENTS_MS))
    }
  }

  console.log(`[scrape-files] Done: ${successCount}/${rows.length} scraped successfully`)
  return successCount
}
