import { discoverAnimesDigital, resolveAnimesDigital } from './animesdigital'
import { discoverAnimeFire, resolveAnimeFire } from './animefire'
import type { AnimeHttpProvider, AnimeHttpRequest } from './provider-types'

export const animeHttpProviders: readonly AnimeHttpProvider[] = [
  { id: 'animesdigital', name: 'AnimesDigital',
    discover: (request, signal) => discoverAnimesDigital(request.titles, request.targetEpisode, signal), resolve: resolveAnimesDigital },
  { id: 'animefire', name: 'AnimeFire', discover: discoverAnimeFire, resolve: resolveAnimeFire },
]

export function httpProviderMetadata() {
  return animeHttpProviders.map(({ id, name }) => ({ id, name, type: 'http' as const,
    contentType: 'anime' as const, audioTypes: ['dubbed', 'subbed'] }))
}

/** Uma fonte indisponível não impede a coleta das demais. */
export async function discoverAnimeHttpSources(request: AnimeHttpRequest, signal?: AbortSignal,
  providers: readonly AnimeHttpProvider[] = animeHttpProviders) {
  const results = await Promise.allSettled(providers.map((provider) => provider.discover(request, signal)))
  const episodes = results.flatMap((result) => result.status === 'fulfilled' ? result.value : [])
  const sourceWarnings = results.flatMap((result, index) => result.status === 'rejected'
    ? [`${providers[index]!.name} (${request.titles[0]}): ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`] : [])
  return { episodes, sourceWarnings }
}
