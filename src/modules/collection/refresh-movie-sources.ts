import { and, eq, inArray, sql } from 'drizzle-orm'
import { db } from '../../db'
import { normalizeTitle, parseRelease, type RawTorrent } from '../../lib/parse'
import { contents, content_torrents, torrents } from '../../types'
import { queryApibay } from './sources/apibay'
import { searchSolidTorrents } from './sources/solidtorrents'

const MOVIE_CATEGORY = 201
const FAKE_RE = /\.(exe|scr|lnk|bat|msi)\b/i

function yearMatches(releaseTitle: string, year: number | null): boolean {
  if (year == null) return true
  const years = releaseTitle.match(/\b(19|20)\d{2}\b/g)
  return !years?.length || years.includes(String(year))
}

function titleMatches(releaseTitle: string, targets: string[]): boolean {
  const parsed = normalizeTitle(parseRelease(releaseTitle).title)
  if (!parsed) return false
  return targets.some((target) => {
    const normalized = normalizeTitle(target)
    return normalized.length >= 3 && (parsed.includes(normalized) || normalized.includes(parsed))
  })
}

function qualityRank(title: string): number {
  if (/\b(2160p|4k|uhd)\b/i.test(title)) return 4
  if (/\b1080p\b/i.test(title)) return 3
  if (/\b720p\b/i.test(title)) return 2
  if (/\b(576p|480p)\b/i.test(title)) return 1
  return 0
}

export interface MovieSourceRefreshResult {
  sourcesFound: number
  sourcesAdded: number
}

/** Busca fontes atuais em múltiplos índices, vincula todas as opções válidas e elege a melhor. */
export async function refreshMovieSources(contentId: number): Promise<MovieSourceRefreshResult> {
  const [movie] = await db
    .select({
      id: contents.id,
      type: contents.type,
      title: contents.title,
      original_title: contents.original_title,
      year: contents.year,
    })
    .from(contents)
    .where(eq(contents.id, contentId))
    .limit(1)

  if (!movie) throw new Error(`Content ${contentId} not found`)
  if (movie.type !== 'movie') throw new Error(`Content ${contentId} is not a movie`)

  const titles = Array.from(
    new Set([movie.original_title, movie.title].filter((value): value is string => !!value?.trim())),
  )
  const found = new Map<string, RawTorrent>()

  for (const title of titles) {
    const baseQuery = `${title} ${movie.year ?? ''}`.trim()
    // SolidTorrents limita a frequência; mantemos as buscas sequenciais para
    // não transformar um clique do usuário em uma rajada de 429s.
    const batches = [
      await queryApibay(baseQuery, MOVIE_CATEGORY, 'movies'),
      await searchSolidTorrents(baseQuery, 50),
      await searchSolidTorrents(`${baseQuery} 1080p`, 30),
      await searchSolidTorrents(`${baseQuery} 2160p`, 30),
    ]
    for (const torrent of batches.flat()) {
      if (!torrent.hash || (torrent.seeds ?? 0) < 1) continue
      if (FAKE_RE.test(torrent.title)) continue
      if (!yearMatches(torrent.title, movie.year)) continue
      if (!titleMatches(torrent.title, titles)) continue
      const parsed = parseRelease(torrent.title)
      if (parsed.season != null || parsed.episode != null) continue
      found.set(torrent.hash, { ...torrent, category: 'movies' })
    }
  }

  const candidates = [...found.values()]
    .sort((a, b) => qualityRank(b.title) - qualityRank(a.title) || b.seeds - a.seeds)
    .slice(0, 60)
  if (candidates.length === 0) return { sourcesFound: 0, sourcesAdded: 0 }

  const hashes = candidates.map((torrent) => torrent.hash)
  const linkedBefore = await db
    .select({ hash: torrents.hash })
    .from(content_torrents)
    .innerJoin(torrents, eq(torrents.id, content_torrents.torrent_id))
    .where(and(eq(content_torrents.content_id, contentId), inArray(torrents.hash, hashes)))
  const alreadyLinked = new Set(linkedBefore.map((row) => row.hash))

  for (const torrent of candidates) {
    await db
      .insert(torrents)
      .values({
        source: torrent.source,
        hash: torrent.hash,
        title: torrent.title.slice(0, 512),
        magnet_link: torrent.magnet_link,
        seeds: torrent.seeds,
        leechers: torrent.leechers,
        size_bytes: torrent.size_bytes ?? null,
        uploader: torrent.uploader ? torrent.uploader.slice(0, 128) : null,
        category: 'movies',
        published_at: torrent.published_at ?? null,
        collected_at: new Date(),
        last_seen_at: new Date(),
      })
      .onConflictDoUpdate({
        target: torrents.hash,
        set: {
          seeds: torrent.seeds,
          leechers: torrent.leechers,
          size_bytes: torrent.size_bytes ?? null,
          last_seen_at: sql`now()`,
        },
      })
  }

  const stored = await db
    .select({ id: torrents.id, hash: torrents.hash })
    .from(torrents)
    .where(inArray(torrents.hash, hashes))
  if (stored.length > 0) {
    await db
      .insert(content_torrents)
      .values(stored.map((torrent) => ({
        content_id: contentId,
        torrent_id: torrent.id,
        is_primary: false,
        season: null,
        episode: null,
        added_at: new Date(),
      })))
      .onConflictDoNothing()
  }

  const linked = await db
    .select({ id: torrents.id, title: torrents.title, seeds: torrents.seeds })
    .from(content_torrents)
    .innerJoin(torrents, eq(torrents.id, content_torrents.torrent_id))
    .where(eq(content_torrents.content_id, contentId))
  const best = linked.sort(
    (a, b) => qualityRank(b.title) - qualityRank(a.title) || (b.seeds ?? 0) - (a.seeds ?? 0),
  )[0]
  if (best) {
    await db.update(content_torrents).set({ is_primary: false }).where(eq(content_torrents.content_id, contentId))
    await db
      .update(content_torrents)
      .set({ is_primary: true })
      .where(and(eq(content_torrents.content_id, contentId), eq(content_torrents.torrent_id, best.id)))
  }

  return {
    sourcesFound: candidates.length,
    sourcesAdded: candidates.filter((torrent) => !alreadyLinked.has(torrent.hash)).length,
  }
}
