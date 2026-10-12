export type AnimeAudioType = 'dubbed' | 'subbed'
export type AnimeHttpProviderId = 'animesdigital' | 'animefire' | 'animesonline'

export interface AnimeHttpEpisode {
  provider: AnimeHttpProviderId
  pageUrl: string
  title: string
  /** Número local da parte; o serviço aplica o offset da franquia. */
  episode: number
  audioType: AnimeAudioType
}

export interface AnimeHttpRequest {
  titles: string[]
  seriesTitles?: string[]
  season?: number
  episodeOffset?: number
  episodeCount?: number | null
  targetEpisode?: number
}

export interface ResolvedHttpStream {
  url: string
  quality: string | null
  /** Necessário quando o provedor publica HLS com extensão diferente de .m3u8. */
  mimeType?: string
}

export interface AnimeHttpProvider {
  id: AnimeHttpProviderId
  name: string
  discover(request: AnimeHttpRequest, signal?: AbortSignal): Promise<AnimeHttpEpisode[]>
  resolve(pageUrl: string): Promise<ResolvedHttpStream>
}
