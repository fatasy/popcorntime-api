import type { EpisodeInfo } from '../torrent/episodes'
import type { http_streams } from '../../types'

export interface HttpEpisodeSource {
  id: number
  provider: string
  title: string
  season: number
  episode: number
  audio_type: string
  stream_url: string | null
  quality: string | null
  collected_at: string
}

/** Anexa fontes HTTP inclusive quando o catálogo externo não trouxe o episódio. */
export function mergeHttpEpisodeSources(episodes: EpisodeInfo[], streams: (typeof http_streams.$inferSelect)[]): EpisodeInfo[] {
  const byEpisode = new Map(episodes.map((ep) => [`${ep.season}:${ep.episode}`, { ...ep, streams: [] as HttpEpisodeSource[] }]))
  for (const stream of streams) {
    const key = `${stream.season}:${stream.episode}`
    const episode = byEpisode.get(key) ?? { season: stream.season, episode: stream.episode,
      title: null, air_date: null, torrents: [], streams: [] }
    episode.streams.push({ id: stream.id, provider: stream.provider, title: stream.title,
      season: stream.season, episode: stream.episode, audio_type: stream.audio_type,
      stream_url: stream.stream_url, quality: stream.quality, collected_at: stream.collected_at.toISOString() })
    byEpisode.set(key, episode)
  }
  return [...byEpisode.values()].sort((a, b) => a.season - b.season || a.episode - b.episode)
}
