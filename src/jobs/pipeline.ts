import { collectTorrents, type Category } from '../modules/collection'
import { enrichPending } from '../modules/enrichment'
import { scrapeFileLists } from '../modules/enrichment/scrape-files'
import { fillGaps } from '../modules/collection/fill-gaps'
import { groupUngrouped } from '../modules/grouping'
import { mergeByTmdbId } from '../modules/grouping/merge-series'
import { runDiscovery } from './discover'

const CATEGORIES: Category[] = ['movies', 'series', 'anime']

/**
 * Full ingestion pipeline:
 *   0. (opt-in) discover new content from TMDB + Jikan
 *   1. collect torrents for every category
 *   2. enrich contents that have no metadata yet
 *   3. fill gaps — find missing seasons/episodes for enriched series
 *   4. merge duplicate series contents by tmdb_id
 *   5. group ungrouped torrents into contents
 *   6. scrape file lists from LimeTorrents
 */
export async function runPipeline(): Promise<void> {
  console.log('=== PopcornTime pipeline start ===')

  // Step 0: Discovery (opt-in via PIPELINE_DISCOVER=1)
  if (process.env.PIPELINE_DISCOVER === '1') {
    console.log('\n[0/3] Discovering new content…')
    try {
      const d = await runDiscovery()
      console.log(`[discover] +${d.movies} movies, +${d.series} series, +${d.anime} anime, ${d.torrents} torrents`)
    } catch (err) {
      console.error('[pipeline] discovery failed:', err)
    }
  }

  let newTorrents = 0
  for (const category of CATEGORIES) {
    console.log(`\n[1/3] Collecting "${category}"…`)
    try {
      newTorrents += await collectTorrents(category)
    } catch (err) {
      console.error(`[pipeline] collect ${category} failed:`, err)
    }
  }

  console.log('\n[2/3] Enriching unenriched contents…')
  let enriched = 0
  try {
    enriched = await enrichPending(100)
  } catch (err) {
    console.error('[pipeline] enrichment failed:', err)
  }

  console.log('\n[2.2/3] Filling series gaps (missing seasons/episodes)…')
  let gapResults: { torrentsAdded: number }[] = []
  try {
    gapResults = await fillGaps(5)
  } catch (err) {
    console.error('[pipeline] gap filling failed:', err)
  }
  const gapTorrents = gapResults.reduce((s, r) => s + r.torrentsAdded, 0)

  console.log('\n[2.5/3] Merging duplicate series by tmdb_id…')
  let merged = 0
  try {
    merged = await mergeByTmdbId()
  } catch (err) {
    console.error('[pipeline] merge failed:', err)
  }

  console.log('\n[3/3] Grouping ungrouped torrents…')
  let grouped = { matched: 0, created: 0 }
  try {
    grouped = await groupUngrouped(500)
  } catch (err) {
    console.error('[pipeline] grouping failed:', err)
  }

  console.log(
    `\n=== Pipeline done: +${newTorrents} torrents, ${enriched} enriched, ` +
      `${gapTorrents} gap-filled, ${merged} series merged, ${grouped.created} contents created, ${grouped.matched} matched ===`,
  )

  console.log('\n[4/3] Scraping file lists from LimeTorrents…')
  try {
    const scraped = await scrapeFileLists(25)
    console.log(`[scrape] ${scraped} file lists scraped`)
  } catch (err) {
    console.error('[pipeline] file-list scraping failed:', err)
  }

  console.log('=== Pipeline complete ===')
}

if (import.meta.main) {
  await runPipeline()
  process.exit(0)
}
