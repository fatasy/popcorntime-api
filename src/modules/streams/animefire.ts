import { z } from 'zod'
import { normalizeAnimeTitle, publicMediaUrl } from './animesdigital'
import type { AnimeAudioType, AnimeHttpEpisode, AnimeHttpRequest, ResolvedHttpStream } from './provider-types'

export const ANIMEFIRE_API = 'https://api.animefire.one'
const MAX_JSON_BYTES = 4 * 1024 * 1024
const idSchema = z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/)
const titlesSchema = z.record(z.string(), z.string().nullable())
const searchSchema = z.object({ data: z.array(z.object({ id: idSchema, titles: titlesSchema })) })
const detailSchema = z.object({ data: z.object({
  hero: z.object({ id: idSchema, titles: titlesSchema }),
  seasons: z.array(z.object({ number: z.number() })),
  episodes: z.array(z.object({ id: idSchema, season: z.number(), number: z.number(),
    title: z.string().nullable(), audio: z.string() })),
}) })
const episodeSchema = z.object({ data: z.object({ streams: z.array(z.object({
  audio: z.string(), is_offline: z.boolean(), url: z.string().nullable(),
})) }) })

/** Só consulta JSON da API pública; nunca abre o manifesto ou o vídeo. */
async function readJson(path: string, signal?: AbortSignal): Promise<unknown> {
  const response = await fetch(`${ANIMEFIRE_API}${path}`, {
    redirect: 'error', cache: 'no-store',
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000),
    headers: { Accept: 'application/json', 'User-Agent': 'fpopcorntime/1.4 anime-catalog' },
  })
  if (!response.ok || !/application\/json/i.test(response.headers.get('content-type') ?? '')) {
    await response.body?.cancel()
    throw new Error(response.ok ? 'AnimeFire retornou conteúdo diferente de JSON' : `AnimeFire HTTP ${response.status}`)
  }
  const reader = response.body?.getReader()
  if (!reader) throw new Error('Resposta da AnimeFire vazia')
  const decoder = new TextDecoder()
  let text = '', bytes = 0
  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      bytes += chunk.value.byteLength
      if (bytes > MAX_JSON_BYTES) throw new Error('AnimeFire excedeu o limite de tamanho da resposta')
      text += decoder.decode(chunk.value, { stream: true })
    }
    return JSON.parse(text + decoder.decode())
  } finally { await reader.cancel() }
}

function normalizedTitles(titles: string[]): Set<string> {
  return new Set(titles.map(normalizeAnimeTitle).filter(Boolean))
}

function matches(titles: Record<string, string | null>, wanted: Set<string>): boolean {
  return Object.values(titles).some((title) => title != null && wanted.has(normalizeAnimeTitle(title)))
}

function audioTypes(value: string): AnimeAudioType[] {
  const result: AnimeAudioType[] = []
  if (/dublado/i.test(value)) result.push('dubbed')
  if (/legendado/i.test(value)) result.push('subbed')
  return result
}

export function parseAnimeFireSearch(json: unknown, titles: string[]): { id: string; titles: Record<string, string | null> }[] {
  const wanted = normalizedTitles(titles)
  return searchSchema.parse(json).data.filter((anime) => matches(anime.titles, wanted))
}

export function parseAnimeFireEpisodes(json: unknown, request: AnimeHttpRequest): AnimeHttpEpisode[] {
  const { data } = detailSchema.parse(json)
  const requestedSeason = request.season ?? 1
  const rootMatches = matches(data.hero.titles, normalizedTitles(request.seriesTitles ?? request.titles))
  const entryMatches = matches(data.hero.titles, normalizedTitles(request.titles))
  if (!rootMatches && !entryMatches) return []
  // A AnimeFire reúne temporadas num título. Edições separadas podem usar T1
  // internamente mesmo quando correspondem a uma temporada posterior no MAL.
  const providerSeason = data.seasons.some((season) => season.number === requestedSeason) ? requestedSeason
    : !rootMatches && entryMatches && data.seasons.length === 1 ? data.seasons[0]!.number : null
  if (providerSeason == null) return []
  const offset = rootMatches ? request.episodeOffset ?? 0 : 0
  const found = new Map<string, AnimeHttpEpisode>()
  for (const episode of data.episodes) {
    if (episode.season !== providerSeason || !Number.isSafeInteger(episode.number)) continue
    // episodes[].number já é local à temporada. first_episode_number é apenas
    // a posição absoluta da temporada no site, não deve ser subtraída aqui.
    const localNumber = episode.number - offset
    if (localNumber < 1 || (request.episodeCount != null && localNumber > request.episodeCount) ||
      (request.targetEpisode != null && localNumber !== request.targetEpisode)) continue
    for (const audioType of audioTypes(episode.audio)) {
      // O fragmento distingue as duas versões na mesma referência sem alterar
      // a requisição enviada à API nem depender de uma URL temporária da CDN.
      const pageUrl = `${ANIMEFIRE_API}/episode/${episode.id}?v=3#audio=${audioType}`
      const title = `${data.hero.titles.BR ?? data.hero.titles.US ?? request.titles[0]} · Episódio ${episode.number}`
      found.set(pageUrl, { provider: 'animefire', pageUrl, title, episode: localNumber, audioType })
    }
  }
  return [...found.values()].sort((a, b) => a.episode - b.episode || a.audioType.localeCompare(b.audioType))
}

export async function discoverAnimeFire(request: AnimeHttpRequest, signal?: AbortSignal): Promise<AnimeHttpEpisode[]> {
  const titles = [...request.titles, ...(request.seriesTitles ?? [])]
  const queries = [...new Set(titles.filter((title) => normalizeAnimeTitle(title)))].slice(0, 6)
  let hits: ReturnType<typeof parseAnimeFireSearch> = []
  for (const query of queries) {
    hits = parseAnimeFireSearch(await readJson(`/animes/pesquisar?q=${encodeURIComponent(query)}&v=3`, signal), titles)
    if (hits.length) break
  }
  const found = new Map<string, AnimeHttpEpisode>()
  for (const hit of hits.slice(0, 4)) {
    const json = await readJson(`/anime/${hit.id}?v=3`, signal)
    for (const episode of parseAnimeFireEpisodes(json, request)) found.set(episode.pageUrl, episode)
  }
  return [...found.values()]
}

export function extractAnimeFireStream(json: unknown, audioType: AnimeAudioType): ResolvedHttpStream | null {
  for (const stream of episodeSchema.parse(json).data.streams) {
    if (stream.is_offline || !audioTypes(stream.audio).includes(audioType) || !stream.url) continue
    const url = publicMediaUrl(stream.url)
    if (!url) continue
    const parsed = new URL(url)
    if (/\.m3u8$/i.test(parsed.pathname) || (parsed.hostname === 'akumast.net' && /^\/i\/[a-zA-Z0-9_-]+\/h\.jpg$/.test(parsed.pathname))) {
      return { url, quality: null, mimeType: 'application/vnd.apple.mpegurl' }
    }
    if (/\.(mp4|webm)$/i.test(parsed.pathname)) {
      return { url, quality: null, mimeType: /\.webm$/i.test(parsed.pathname) ? 'video/webm' : 'video/mp4' }
    }
  }
  return null
}

export async function resolveAnimeFire(pageUrl: string): Promise<ResolvedHttpStream> {
  const page = new URL(pageUrl)
  const id = page.pathname.match(/^\/episode\/([a-zA-Z0-9_-]{1,80})$/)?.[1]
  const audioType = page.hash === '#audio=dubbed' ? 'dubbed' : page.hash === '#audio=subbed' ? 'subbed' : null
  if (page.origin !== ANIMEFIRE_API || page.username || page.password || !id || !audioType) {
    throw new Error('Referência da AnimeFire inválida')
  }
  const stream = extractAnimeFireStream(await readJson(`/episode/${id}?v=3`), audioType)
  if (!stream) throw new Error('AnimeFire: versão de áudio indisponível ou sem URL HTTP direta compatível')
  return stream
}
