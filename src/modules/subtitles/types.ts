export type MediaType = 'movie' | 'series'

export interface SubtitleQuery {
  type: MediaType
  imdbId?: string // "tt1254207"
  tmdbId?: number
  season?: number // séries
  episode?: number // séries
  title?: string // fallback p/ busca textual
  year?: number
  languages: string[] // canônicos, em ordem de preferência: ["pt-BR","pt-PT","en"]
}

export interface SubtitleResult {
  provider: string // "opensubtitles"
  ref: string // payload opaco (serializado) que o provider usa em fetchFile()
  lang: string // canônico "pt-BR"
  langLabel: string // "Português (Brasil)"
  release: string // nome do release/arquivo
  downloads: number // download_count (proxy de qualidade)
  rating: number // 0-10
  hashMatch: boolean // moviehash_match
  hearingImpaired: boolean
  format: string // "srt"
}

export interface SubtitleProvider {
  readonly id: string
  /** false quando faltam credenciais → o agregador o ignora. */
  readonly enabled: boolean
  search(q: SubtitleQuery): Promise<SubtitleResult[]>
  /** Baixa o arquivo bruto (pode vir gzip e/ou Latin-1) referente a `ref`. */
  fetchFile(ref: string): Promise<Uint8Array>
}
