import { eq, inArray } from 'drizzle-orm'
import { db } from '../../db'
import { parseRelease } from '../../lib/parse'
import {
  anime_franchise_entries,
  contents,
  content_torrents,
  profile_favorites,
  profile_progress,
  torrent_episodes,
  torrents,
} from '../../types'
import {
  getAnimeAiredEpisodeCount,
  getAnimeFull,
  type JikanAnimeFull,
} from '../enrichment/myanimelist'

const JIKAN_DELAY_MS = 400

export interface AnimeFranchiseSeason {
  malId: number
  season: number
  part: number
  episodeOffset: number
  episodeCount: number | null
  title: string
  titleEnglish: string | null
  titleJapanese: string | null
  year: number | null
  airedFrom: string | null
}

function explicitSeason(title: string): number | null {
  const match =
    title.match(/\bseason\s*(\d{1,2})\b/i) ??
    title.match(/\b(\d{1,2})(?:st|nd|rd|th)\s+season\b/i) ??
    title.match(/第\s*(\d{1,2})\s*期/u)
  return match ? Number(match[1]) : null
}

function explicitPart(title: string): number {
  const match = title.match(/\bpart\s*(\d{1,2})\b/i) ?? title.match(/\b(\d{1,2})(?:st|nd|rd|th)\s+cour\b/i)
  return match ? Number(match[1]) : 1
}

export function baseAnimeTitle(title: string): string {
  return title
    .replace(/\s+\d+(?:st|nd|rd|th)\s+season(?:\s+part\s+\d+)?\s*$/i, '')
    .replace(/\s+season\s*\d+(?:\s+part\s+\d+)?\s*$/i, '')
    .replace(/\s+part\s+\d+\s*$/i, '')
    .replace(/[\s:–—-]+$/, '')
    .trim()
}

/**
 * Percorre somente relações Prequel/Sequel entre animes de TV. Filmes, OVAs e
 * histórias paralelas não viram temporadas do título principal.
 */
export async function discoverAnimeFranchise(seedMalId: number): Promise<AnimeFranchiseSeason[]> {
  const queue = [seedMalId]
  const seen = new Set<number>()
  const records: JikanAnimeFull[] = []

  while (queue.length > 0 && seen.size < 30) {
    const malId = queue.shift()!
    if (seen.has(malId)) continue
    seen.add(malId)

    const anime = await getAnimeFull(malId)
    // Nunca consolida uma cadeia parcial: isso poderia renomear o canônico e
    // ocultar temporadas justamente durante uma indisponibilidade do Jikan.
    if (!anime) return []
    if (anime.type && anime.type !== 'TV') continue
    records.push(anime)

    for (const relation of anime.relations ?? []) {
      if (relation.relation !== 'Prequel' && relation.relation !== 'Sequel') continue
      for (const entry of relation.entry ?? []) {
        if (entry.type === 'anime' && !seen.has(entry.mal_id)) queue.push(entry.mal_id)
      }
    }
    if (queue.length > 0) await Bun.sleep(JIKAN_DELAY_MS)
  }

  records.sort((a, b) => {
    const dateA = a.aired?.from ?? `${a.year ?? 9999}-12-31`
    const dateB = b.aired?.from ?? `${b.year ?? 9999}-12-31`
    return dateA.localeCompare(dateB) || a.mal_id - b.mal_id
  })

  const result: AnimeFranchiseSeason[] = []
  let currentSeason = 0
  for (const anime of records) {
    const title = anime.title_english ?? anime.title ?? `MAL ${anime.mal_id}`
    const parsedSeason = explicitSeason(`${title} ${anime.title ?? ''}`)
    const part = explicitPart(`${title} ${anime.title ?? ''}`)
    const season = parsedSeason ?? (part > 1 && currentSeason > 0 ? currentSeason : currentSeason + 1)
    currentSeason = Math.max(currentSeason, season)

    let episodeCount = anime.episodes ?? null
    if (episodeCount == null) {
      await Bun.sleep(JIKAN_DELAY_MS)
      episodeCount = await getAnimeAiredEpisodeCount(anime.mal_id)
    }

    result.push({
      malId: anime.mal_id,
      season,
      part,
      episodeOffset: 0,
      episodeCount,
      title,
      titleEnglish: anime.title_english ?? null,
      titleJapanese: anime.title_japanese ?? null,
      year: anime.year ?? anime.aired?.prop?.from?.year ?? null,
      airedFrom: anime.aired?.from ?? null,
    })
  }

  // Partes/cours da mesma temporada usam numeração contínua na nossa API.
  const offsets = new Map<number, number>()
  for (const entry of result.sort((a, b) => a.season - b.season || a.part - b.part)) {
    entry.episodeOffset = offsets.get(entry.season) ?? 0
    offsets.set(entry.season, entry.episodeOffset + (entry.episodeCount ?? 0))
  }
  return result
}

export async function resolveCanonicalContentId(contentId: number): Promise<number> {
  const [row] = await db
    .select({ canonicalId: contents.canonical_content_id })
    .from(contents)
    .where(eq(contents.id, contentId))
    .limit(1)
  return row?.canonicalId ?? contentId
}

function normalizeTorrentPosition(
  rawTitle: string,
  storedEpisode: number | null,
  sourceEntry: AnimeFranchiseSeason,
  entries: AnimeFranchiseSeason[],
): { season: number; episode: number | null } {
  const parsed = parseRelease(rawTitle)
  const rawEpisode = parsed.episode ?? storedEpisode
  const titleSeason = parsed.season ?? explicitSeason(rawTitle)
  const titlePart = explicitPart(rawTitle)
  const targetEntry =
    entries.find((entry) => entry.season === titleSeason && entry.part === titlePart) ??
    entries.find((entry) => entry.season === titleSeason) ??
    sourceEntry
  const targetSeason = targetEntry.season
  if (rawEpisode == null || rawEpisode <= 0) return { season: targetSeason, episode: null }

  const totals = new Map<number, number>()
  for (const entry of entries) {
    totals.set(
      entry.season,
      Math.max(totals.get(entry.season) ?? 0, entry.episodeOffset + (entry.episodeCount ?? 0)),
    )
  }
  const targetTotal = totals.get(targetSeason) ?? targetEntry.episodeCount ?? 0

  // Partes normalmente reiniciam em 1; na API elas continuam a numeração da
  // temporada (Parte 2 ep. 1 => episódio 13, por exemplo).
  if (
    targetEntry.episodeOffset > 0 &&
    targetEntry.episodeCount != null &&
    rawEpisode <= targetEntry.episodeCount
  ) {
    return { season: targetSeason, episode: targetEntry.episodeOffset + rawEpisode }
  }
  if (targetTotal <= 0 || rawEpisode <= targetTotal) {
    return { season: targetSeason, episode: rawEpisode }
  }

  // Alguns grupos numeram toda a obra de forma absoluta (ex.: 73 = T4E1).
  let cumulative = 0
  for (const season of [...totals.keys()].sort((a, b) => a - b)) {
    const total = totals.get(season) ?? 0
    if (rawEpisode <= cumulative + total) {
      return { season, episode: rawEpisode - cumulative }
    }
    cumulative += total
  }
  return { season: targetSeason, episode: null }
}

/**
 * Consolida todas as temporadas MAL no content solicitado. O ID solicitado é
 * mantido como canônico para que a URL/favoritos existentes não quebrem.
 */
export async function consolidateAnimeFranchise(contentId: number): Promise<{
  contentId: number
  entries: AnimeFranchiseSeason[]
}> {
  let canonicalId = await resolveCanonicalContentId(contentId)
  const [content] = await db.select().from(contents).where(eq(contents.id, canonicalId)).limit(1)
  if (!content || content.type !== 'anime' || !content.mal_id) {
    return { contentId: canonicalId, entries: [] }
  }

  const entries = await discoverAnimeFranchise(content.mal_id)
  if (entries.length === 0) return { contentId: canonicalId, entries: [] }
  const malIds = entries.map((entry) => entry.malId)
  const [established] = await db
    .select({ contentId: anime_franchise_entries.content_id })
    .from(anime_franchise_entries)
    .where(inArray(anime_franchise_entries.mal_id, malIds))
    .limit(1)
  if (established) canonicalId = established.contentId
  const related = await db
    .select()
    .from(contents)
    .where(inArray(contents.mal_id, malIds))
  const sourceById = new Map(related.map((row) => [row.id, row]))
  if (!sourceById.has(canonicalId)) sourceById.set(canonicalId, content)
  const entryByMal = new Map(entries.map((entry) => [entry.malId, entry]))

  await db.transaction(async (tx) => {
    for (const entry of entries) {
      await tx
        .insert(anime_franchise_entries)
        .values({
          content_id: canonicalId,
          mal_id: entry.malId,
          season_number: entry.season,
          part_number: entry.part,
          episode_offset: entry.episodeOffset,
          title: entry.title.slice(0, 512),
          title_english: entry.titleEnglish?.slice(0, 512) ?? null,
          title_japanese: entry.titleJapanese?.slice(0, 512) ?? null,
          year: entry.year,
          episode_count: entry.episodeCount,
          updated_at: new Date(),
        })
        .onConflictDoUpdate({
          target: anime_franchise_entries.mal_id,
          set: {
            content_id: canonicalId,
            season_number: entry.season,
            part_number: entry.part,
            episode_offset: entry.episodeOffset,
            title: entry.title.slice(0, 512),
            title_english: entry.titleEnglish?.slice(0, 512) ?? null,
            title_japanese: entry.titleJapanese?.slice(0, 512) ?? null,
            year: entry.year,
            episode_count: entry.episodeCount,
            updated_at: new Date(),
          },
        })
    }

    for (const [sourceId, source] of sourceById) {
      const entry = source.mal_id ? entryByMal.get(source.mal_id) : undefined
      if (!entry) continue
      const linked = await tx
        .select({
          torrentId: content_torrents.torrent_id,
          title: torrents.title,
          isPrimary: content_torrents.is_primary,
          episode: content_torrents.episode,
        })
        .from(content_torrents)
        .innerJoin(torrents, eq(torrents.id, content_torrents.torrent_id))
        .where(eq(content_torrents.content_id, sourceId))

      for (const link of linked) {
        const position = normalizeTorrentPosition(link.title, link.episode, entry, entries)
        await tx
          .insert(content_torrents)
          .values({
            content_id: canonicalId,
            torrent_id: link.torrentId,
            is_primary: link.isPrimary,
            season: position.season,
            episode: position.episode,
          })
          .onConflictDoUpdate({
            target: [content_torrents.content_id, content_torrents.torrent_id],
            set: {
              season: position.season,
              episode: position.episode,
            },
          })
      }
      if (sourceId !== canonicalId) {
        await tx.delete(content_torrents).where(eq(content_torrents.content_id, sourceId))
        await tx
          .update(contents)
          .set({ canonical_content_id: canonicalId, updated_at: new Date() })
          .where(eq(contents.id, sourceId))
      }
    }

    const aliasIds = [...sourceById.keys()].filter((id) => id !== canonicalId)
    if (aliasIds.length > 0) {
      // Favoritos são deduplicados antes de remover os registros dos aliases.
      const aliasFavorites = await tx
        .select()
        .from(profile_favorites)
        .where(inArray(profile_favorites.content_id, aliasIds))
      if (aliasFavorites.length > 0) {
        await tx
          .insert(profile_favorites)
          .values(aliasFavorites.map((favorite) => ({ ...favorite, content_id: canonicalId })))
          .onConflictDoNothing()
      }
      await tx.delete(profile_favorites).where(inArray(profile_favorites.content_id, aliasIds))
      await tx
        .update(profile_progress)
        .set({ content_id: canonicalId })
        .where(inArray(profile_progress.content_id, aliasIds))
      await tx.delete(torrent_episodes).where(inArray(torrent_episodes.content_id, aliasIds))
    }
    await tx.delete(torrent_episodes).where(eq(torrent_episodes.content_id, canonicalId))

    const root = [...entries].sort((a, b) =>
      a.season - b.season || a.part - b.part || (a.airedFrom ?? '').localeCompare(b.airedFrom ?? ''),
    )[0]!
    const canonicalTitle = baseAnimeTitle(root.titleEnglish ?? root.title) || root.title
    await tx
      .update(contents)
      .set({
        title: canonicalTitle.slice(0, 512),
        original_title: (root.titleJapanese ?? root.title).slice(0, 512),
        year: root.year,
        mal_id: root.malId,
        season: Math.max(...entries.map((entry) => entry.season)),
        canonical_content_id: null,
        updated_at: new Date(),
      })
      .where(eq(contents.id, canonicalId))
  })

  return { contentId: canonicalId, entries }
}
