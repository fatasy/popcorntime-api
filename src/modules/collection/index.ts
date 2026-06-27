import { inArray, sql } from 'drizzle-orm'
import { db } from '../../db'
import { torrents } from '../../types'
import type { RawTorrent } from '../../lib/parse'
import { fetchApibayTop100, queryApibay } from './sources/apibay'

// Our category label -> TPB/apibay numeric category id.
export const CATEGORIES = {
  movies: 201,
  series: 205,
  anime: 202,
} as const

export type Category = keyof typeof CATEGORIES

/**
 * Collect torrents for a category.
 * Primary: apibay precompiled top100. Fallback: apibay search queries.
 * New torrents are inserted; already-known ones (by hash) have their
 * `last_seen_at` bumped. Returns the number of newly inserted torrents.
 */
export async function collectTorrents(category: Category): Promise<number> {
  const cat = CATEGORIES[category]
  let raw: RawTorrent[] = []

  // 1) Primary source: apibay precompiled top100 (TPB HTML is JS-rendered, unscrapeable)
  try {
    raw = await fetchApibayTop100(cat, category)
  } catch (err) {
    console.warn(`[collect] apibay top100 failed for ${category}:`, (err as Error).message)
  }

  // 2) Fallback: search for popular terms to supplement
  if (raw.length < 20) {
    try {
      const extra = await queryApibay(category, cat, category)
      if (extra.length) raw = raw.concat(extra)
    } catch (err) {
      console.warn(`[collect] apibay fallback failed for ${category}:`, (err as Error).message)
    }
  }

  if (raw.length === 0) {
    console.log(`[collect] ${category}: no torrents fetched`)
    return 0
  }

  // Dedupe within the batch by hash.
  const byHash = new Map<string, RawTorrent>()
  for (const t of raw) {
    if (t.hash && !byHash.has(t.hash)) byHash.set(t.hash, t)
  }
  const batch = [...byHash.values()]
  const hashes = batch.map((t) => t.hash)

  // Which hashes already exist?
  const existing = hashes.length
    ? await db.select({ hash: torrents.hash }).from(torrents).where(inArray(torrents.hash, hashes))
    : []
  const existingSet = new Set(existing.map((e) => e.hash))

  const toInsert = batch.filter((t) => !existingSet.has(t.hash))
  const toTouch = batch.filter((t) => existingSet.has(t.hash)).map((t) => t.hash)

  // Bump last_seen_at for torrents we already had.
  if (toTouch.length) {
    try {
      await db
        .update(torrents)
        .set({ last_seen_at: sql`now()` })
        .where(inArray(torrents.hash, toTouch))
    } catch (err) {
      console.warn('[collect] failed to update last_seen_at:', (err as Error).message)
    }
  }

  // Insert the new ones (ignore races on the unique hash).
  let inserted = 0
  if (toInsert.length) {
    const values = toInsert.map((t) => ({
      source: t.source,
      hash: t.hash,
      title: t.title.slice(0, 512),
      magnet_link: t.magnet_link,
      seeds: t.seeds,
      leechers: t.leechers,
      size_bytes: t.size_bytes ?? null,
      uploader: t.uploader ? t.uploader.slice(0, 128) : null,
      category: t.category,
      published_at: t.published_at ?? null,
    }))
    try {
      const result = await db
        .insert(torrents)
        .values(values)
        .onConflictDoNothing({ target: torrents.hash })
        .returning({ id: torrents.id })
      inserted = result.length
    } catch (err) {
      console.warn('[collect] insert failed:', (err as Error).message)
    }
  }

  console.log(
    `[collect] ${category}: ${inserted} new, ${toTouch.length} updated (fetched ${batch.length})`,
  )
  return inserted
}
