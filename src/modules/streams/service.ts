import { and, asc, eq, sql } from 'drizzle-orm'
import { db } from '../../db'
import { anime_franchise_entries, contents, http_streams } from '../../types'
import { animeHttpProviders, discoverAnimeHttpSources } from './providers'
import type { ResolvedHttpStream } from './provider-types'

export async function refreshAnimeHttpSources(contentId: number, target?: { season: number; episode: number }) {
  const [content] = await db.select().from(contents).where(eq(contents.id, contentId)).limit(1)
  if (!content || content.type !== 'anime') return { sourcesAdded: 0, sourceWarnings: [] as string[] }
  const franchise = await db.select().from(anime_franchise_entries)
    .where(eq(anime_franchise_entries.content_id, contentId))
    .orderBy(asc(anime_franchise_entries.season_number), asc(anime_franchise_entries.part_number))
  const entries = franchise.length ? franchise : [{ season_number: 1, episode_offset: 0,
    episode_count: null, title: content.title, title_english: content.original_title, title_japanese: null }]
  let sourcesAdded = 0
  const sourceWarnings: string[] = []
  const root = entries[0]!
  const seriesTitles = [content.title, content.original_title, root.title, root.title_english, root.title_japanese]
    .filter((title): title is string => !!title)
  // Um refresh HTTP tem prazo próprio; não mantém o crawler preso indefinidamente.
  const signal = AbortSignal.timeout(90_000)
  for (const entry of entries) {
    if (signal.aborted) break
    if (target && (entry.season_number !== target.season || target.episode <= entry.episode_offset ||
      (entry.episode_count != null && target.episode > entry.episode_offset + entry.episode_count))) continue
    try {
      const titles = [entry.title, entry.title_english, entry.title_japanese].filter((title): title is string => !!title)
      const result = await discoverAnimeHttpSources({ titles, seriesTitles, season: entry.season_number,
        episodeOffset: entry.episode_offset, episodeCount: entry.episode_count,
        targetEpisode: target ? target.episode - entry.episode_offset : undefined }, signal)
      sourceWarnings.push(...result.sourceWarnings)
      const episodes = result.episodes
      if (!episodes.length) continue
      const values = episodes.filter((ep) => entry.episode_count == null || ep.episode <= entry.episode_count).map((ep) => ({
        content_id: contentId, season: entry.season_number, episode: ep.episode + entry.episode_offset,
        provider: ep.provider, page_url: ep.pageUrl, title: ep.title.slice(0, 512), audio_type: ep.audioType,
      }))
      if (!values.length) continue
      const added = await db.insert(http_streams).values(values).onConflictDoNothing().returning({ id: http_streams.id })
      sourcesAdded += added.length
    } catch (error) {
      sourceWarnings.push(`Fontes HTTP (${entry.title}): ${(error as Error).message}`)
      if (signal.aborted) break
    }
    if (signal.aborted) break
  }
  return { sourcesAdded, sourceWarnings }
}

const activeResolutions = new Map<number, Promise<(ResolvedHttpStream & { id: number }) | null>>()

/** Retorna JSON com URL atualizada. Não há proxy, download ou cache de vídeo. */
export function resolveHttpStream(id: number) {
  const running = activeResolutions.get(id)
  if (running) return running
  const task = (async () => {
    const [source] = await db.select().from(http_streams).where(eq(http_streams.id, id)).limit(1)
    if (!source) return null
    const provider = animeHttpProviders.find((provider) => provider.id === source.provider)
    if (!provider) throw new Error('Provedor HTTP não suportado')
    // Resolve em todo início de reprodução; URLs temporárias não são identidade.
    const stream = await provider.resolve(source.page_url)
    await db.update(http_streams).set({ stream_url: stream.url, quality: stream.quality, resolved_at: new Date() })
      .where(eq(http_streams.id, id))
    return { id, ...stream }
  })().finally(() => activeResolutions.delete(id))
  activeResolutions.set(id, task)
  return task
}

export async function countHttpEpisodeSources(contentId: number, season: number, episode: number): Promise<number> {
  const [row] = await db.select({ count: sql<number>`count(*)::int` }).from(http_streams).where(and(
    eq(http_streams.content_id, contentId), eq(http_streams.season, season), eq(http_streams.episode, episode),
  ))
  return row?.count ?? 0
}
