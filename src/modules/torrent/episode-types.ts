/**
 * Tipos e constantes compartilhados do metadado externo por episódio
 * (`episode_metadata`): o contrato exposto na API, a precedência entre
 * provedores e a atribuição exigida por cada fonte de imagem.
 *
 * Sem dependência de runtime (só tipos/constantes) para que os provedores
 * (`episode-providers.ts`) e a persistência/orquestração (`episode-metadata.ts`)
 * compartilhem o mesmo contrato sem ciclo de import.
 */

export const EPISODE_METADATA_TTL_HOURS = 24
/** Thumbnail do still do TMDB em 300px — o TV app pede a arte, não o still full. */
export const STILL_IMAGE_SIZE = 'w300'
/** Teto de páginas do Jikan (100 eps/página) p/ séries muito longas. */
export const MAX_JIKAN_EPISODE_PAGES = 5
/** Chave-pai no `metadata_cache` para misses/estado de passada deste módulo. */
export const MISS_CACHE_SOURCE = 'episode_meta'
/** Cooldown de um provedor que falhou — evita martelar API fora do ar. */
export const MISS_TTL_MINUTES = 30
/** Estado da passada parcial vale o mesmo que a linha persistida (24h). */
export const PARTIAL_TTL_HOURS = EPISODE_METADATA_TTL_HOURS

// ─── Tipos públicos ────────────────────────────────────────────────────────

export type EpisodeMetadataSource = 'tmdb' | 'jikan' | 'tvmaze' | 'thetvdb'
/** Provedor que preencheu o registro; `none` = nenhuma fonte tinha metadado. */
export type EpisodeMetadataRowSource = EpisodeMetadataSource | 'none'
export type EpisodeImageSource = 'tmdb' | 'tvmaze' | 'thetvdb'
/**
 * Estado da imagem do episódio — contrato estável para o app:
 *  - `still`    → `still_url` é a arte DESTE episódio (provider em `image_source`)
 *  - `fallback` → não há still; `thumbnail_url` é o poster/backdrop do conteúdo
 *  - `none`     → nenhuma imagem: usar placeholder local (`still_url`/`thumbnail_url` null)
 */
export type EpisodeImageKind = 'still' | 'fallback' | 'none'
/** Como o provedor foi vinculado ao conteúdo (auditoria da qualidade do vínculo). */
export type EpisodeImageMatch = 'tmdb' | 'imdb' | 'thetvdb' | 'title'

/** Metadado externo de um episódio, como exposto na API. */
export interface EpisodeMetadata {
  season: number
  episode: number
  source: EpisodeMetadataRowSource
  source_episode_id: string | null
  title: string | null
  title_original: string | null
  overview: string | null
  air_date: string | null
  runtime_sec: number | null
  score: number | null
  filler: boolean | null
  recap: boolean | null
  still_path: string | null
  still_url: string | null
  thumbnail_url: string | null
  image_source: EpisodeImageSource | null
  image_kind: EpisodeImageKind | null
  image_match: EpisodeImageMatch | null
  image_credit: string | null
  image_credit_url: string | null
  image_license: string | null
}

/** Episódio já resolvido pelo TMDB (evita uma segunda chamada ao provedor). */
export interface TmdbEpisodeRecord {
  season: number
  episode: number
  source_episode_id: number | null
  title: string | null
  overview: string | null
  air_date: string | null
  runtime_sec: number | null
  still_path: string | null
}

/** Dados do `contents` necessários para escolher/vincular os provedores. */
export interface EpisodeMetadataContext {
  id: number
  type: string
  title: string | null
  original_title: string | null
  year: number | null
  tmdb_id: number | null
  mal_id: number | null
  imdb_id: string | null
  poster_url: string | null
  backdrop_url: string | null
  /** imdb_id devolvido pelo TMDB (`external_ids`) quando o conteúdo tem tmdb_id. */
  external_imdb_id?: string | null
}

// ─── Precedência e atribuição ──────────────────────────────────────────────

export const PROVIDER_ORDER: EpisodeMetadataSource[] = ['tmdb', 'jikan', 'tvmaze', 'thetvdb']

export const TEXT_RANK: Record<EpisodeMetadataSource, number> = {
  tmdb: 0,
  jikan: 1,
  tvmaze: 2,
  thetvdb: 3,
}

export const IMAGE_RANK: Record<EpisodeImageSource, number> = {
  tmdb: 0,
  tvmaze: 1,
  thetvdb: 2,
}

/** Atribuição exigida por cada fonte de imagem (vai persistida na linha). */
export const IMAGE_CREDITS: Record<
  EpisodeImageSource,
  { credit: string; url: string; license: string | null }
> = {
  tmdb: { credit: 'TMDB', url: 'https://www.themoviedb.org', license: null },
  tvmaze: { credit: 'TVmaze', url: 'https://www.tvmaze.com', license: 'CC BY-SA 4.0' },
  thetvdb: { credit: 'TheTVDB.com', url: 'https://thetvdb.com', license: null },
}

export const metaKey = (season: number, episode: number) => `${season}|${episode}`
export const NONE_RANK = Number.POSITIVE_INFINITY
