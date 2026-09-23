import { eq } from 'drizzle-orm'
import { db } from '../../db'
import { contents } from '../../types'
import { fillGaps } from '../collection/fill-gaps'
import { detectGaps } from '../collection/gap-detector'
import { refreshMovieSources } from '../collection/refresh-movie-sources'
import { enrichContent } from '../enrichment'
import { resolveEpisodes } from '../torrent/episodes'
import { consolidateAnimeFranchise, resolveCanonicalContentId } from '../anime/franchise'

export type RefreshScope = 'all' | 'metadata' | 'sources'

export interface CatalogRefreshResult {
  contentId: number
  type: string
  metadataUpdated: boolean
  sourcesFound: number
  sourcesAdded: number
  episodesCataloged: number
  remainingEpisodes: number
  refreshedAt: string
}

/** Atualiza um único título, na ordem catálogo externo → fontes/torrents. */
export async function refreshCatalogContent(
  contentId: number,
  scope: RefreshScope = 'all',
): Promise<CatalogRefreshResult> {
  let canonicalId = await resolveCanonicalContentId(contentId)
  let [before] = await db.select().from(contents).where(eq(contents.id, canonicalId)).limit(1)
  if (!before) throw new Error('Content not found')

  // MAL publica temporadas/cours como animes diferentes. No nosso catálogo a
  // obra é única: descobre a cadeia e consolida tudo antes de buscar fontes.
  if (before.type === 'anime' && before.mal_id) {
    const consolidated = await consolidateAnimeFranchise(canonicalId)
    canonicalId = consolidated.contentId
    ;[before] = await db.select().from(contents).where(eq(contents.id, canonicalId)).limit(1)
    if (!before) throw new Error('Content not found after anime consolidation')
  }

  let metadataUpdated = false
  if (scope !== 'sources') {
    metadataUpdated = await enrichContent(before, { force: true })
  }

  const [content] = await db.select().from(contents).where(eq(contents.id, canonicalId)).limit(1)
  if (!content) throw new Error('Content not found after enrichment')

  let sourcesFound = 0
  let sourcesAdded = 0
  let episodesCataloged = 0
  let remainingEpisodes = 0

  if (scope !== 'metadata' && content.type === 'movie') {
    const movie = await refreshMovieSources(canonicalId)
    sourcesFound = movie.sourcesFound
    sourcesAdded = movie.sourcesAdded
  }

  if (content.type === 'series' || content.type === 'anime') {
    if (scope !== 'metadata') {
      const filled = await fillGaps(1, {
        contentId: canonicalId,
        forceCatalog: true,
        // Um clique cobre temporadas usuais inteiras, mas mantém a request
        // limitada para séries muito longas. A resposta informa o restante.
        maxEpisodesPerContent: 48,
      })
      sourcesAdded = filled[0]?.torrentsAdded ?? 0
    }

    const episodes = await resolveEpisodes(canonicalId, { forceExternal: scope !== 'sources' })
    episodesCataloged = episodes.filter((episode) => episode.episode > 0).length
    sourcesFound = episodes.reduce((total, episode) => total + episode.torrents.length, 0)

    try {
      const gaps = await detectGaps(canonicalId)
      remainingEpisodes = gaps.gaps.reduce((total, gap) => total + gap.episodes.length, 0)
    } catch {
      remainingEpisodes = 0
    }

    await db
      .update(contents)
      .set({ last_gap_fill_at: new Date(), updated_at: new Date() })
      .where(eq(contents.id, canonicalId))
  }

  return {
    contentId: canonicalId,
    type: content.type,
    metadataUpdated,
    sourcesFound,
    sourcesAdded,
    episodesCataloged,
    remainingEpisodes,
    refreshedAt: new Date().toISOString(),
  }
}
