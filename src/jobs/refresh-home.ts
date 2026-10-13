import { refreshTrendingCatalog } from '../modules/catalog/trending'
import { enrichPending } from '../modules/enrichment'

// Also usable separately, without waiting for torrent scraping or gap filling.
if (import.meta.main) {
  try {
    await refreshTrendingCatalog()
    console.log(`[home] ${await enrichPending(50)} contents enriched`)
    process.exit(0)
  } catch (error) {
    console.error('[home] refresh failed:', (error as Error).message)
    process.exit(1)
  }
}
