// Verificação ao vivo: lê somente HTML/JSON e faz HEAD, sem baixar vídeo.
import { animeHttpProviders } from '../src/modules/streams/providers'

const title = process.argv[2] ?? 'Spy x Family'
const episodeNumber = Number(process.argv[3] ?? 1)
if (!Number.isSafeInteger(episodeNumber) || episodeNumber < 1) throw new Error('Episódio inválido')
const providerId = process.argv[4] ?? 'animesdigital'
const provider = animeHttpProviders.find((provider) => provider.id === providerId)
if (!provider) throw new Error(`Provedor inválido: ${providerId}`)
const episodes = await provider.discover({ titles: [title], targetEpisode: episodeNumber })
if (!episodes.length) throw new Error('Nenhuma referência HTTP encontrada para este título/episódio')
for (const episode of episodes.slice(0, 4)) {
  const stream = await provider.resolve(episode.pageUrl)
  const response = await fetch(stream.url, { method: 'HEAD', signal: AbortSignal.timeout(15_000) })
  await response.body?.cancel()
  if (!response.ok) throw new Error(`CDN HTTP ${response.status}`)
  const contentType = response.headers.get('content-type')
  if (!/mpegurl|video\//i.test(contentType ?? '')) throw new Error(`Tipo de mídia inesperado: ${contentType}`)
  console.log(JSON.stringify({ provider: episode.provider, title: episode.title, audioType: episode.audioType,
    episode: episode.episode, streamHost: new URL(stream.url).host, status: response.status, contentType }))
}
