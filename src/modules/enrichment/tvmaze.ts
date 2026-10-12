// TVMaze — API pública (https://api.tvmaze.com), SEM autenticação.
// É a segunda fonte de imagem POR EPISÓDIO do catálogo: o TMDB cobre os
// conteúdos com `tmdb_id`, mas o TVMaze também entrega uma imagem horizontal
// por episódio para séries/animes onde o TMDB não tem still.
//
// Contrato verificado ao vivo (2026-09-22):
//   GET /lookup/shows?imdb=tt0903747     → 301 → /shows/{id} (o fetch segue o
//                                          redirect e devolve o show) | 404 = não existe
//   GET /lookup/shows?thetvdb=81189      → idem
//   GET /search/shows?q=<titulo>         → [{ score, show }]
//   GET /shows/{id}/episodes?specials=1  → [{ id, season, number, name, summary,
//                                          airdate, runtime, image:{medium,original} }]
//
// Licença/atribuição: as imagens do TVMaze exigem crédito ao TVMaze com link
// (CC BY-SA). O crédito é persistido por episódio em `episode_metadata` e exposto
// na resposta (`image_credit`, `image_credit_url`, `image_license`) — o app DEVE
// exibir o crédito quando `image_source === 'tvmaze'`.
const BASE = 'https://api.tvmaze.com'
const REQUEST_TIMEOUT_MS = 15_000
/** Limite público do TVMaze é ~20 requisições/10s — 300ms entre chamadas. */
const MIN_INTERVAL_MS = 300

let lastRequestAt = 0

async function pace(): Promise<void> {
  const wait = lastRequestAt + MIN_INTERVAL_MS - Date.now()
  if (wait > 0) await new Promise((r) => setTimeout(r, wait))
  lastRequestAt = Date.now()
}

/**
 * GET no TVMaze. `null` = resposta 404 (ausência DEFINITIVA na fonte, não é
 * falha — quem chama não deve marcar "provedor fora do ar"). Qualquer outro
 * status/erro é lançado, para o chamador marcar falha e tentar de novo depois.
 */
async function tvMazeGet<T>(path: string, params: Record<string, string> = {}): Promise<T | null> {
  await pace()
  const url = new URL(BASE + path)
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v)
  const res = await fetch(url, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
  if (res.status === 404) return null
  if (!res.ok) throw new Error(`TVMaze ${res.status} on ${path}`)
  return (await res.json()) as T
}

export interface TvMazeImage {
  medium?: string | null
  original?: string | null
}

export interface TvMazeShow {
  id: number
  name?: string | null
  type?: string | null
  language?: string | null
  premiered?: string | null
  ended?: string | null
  status?: string | null
  externals?: { imdb?: string | null; thetvdb?: number | null; tvrage?: number | null } | null
  image?: TvMazeImage | null
}

export interface TvMazeEpisode {
  id: number
  season: number
  number?: number | null
  name?: string | null
  summary?: string | null
  airdate?: string | null
  runtime?: number | null
  image?: TvMazeImage | null
}

/** Show pelo IMDb id (`tt...`). Vínculo só por id externo → não erra de título. */
export async function lookupShowByImdb(imdbId: string): Promise<TvMazeShow | null> {
  return tvMazeGet<TvMazeShow>('/lookup/shows', { imdb: imdbId })
}

/** Show pelo TheTVDB id. Também vínculo por id externo. */
export async function lookupShowByTheTvdb(tvdbId: number | string): Promise<TvMazeShow | null> {
  return tvMazeGet<TvMazeShow>('/lookup/shows', { thetvdb: String(tvdbId) })
}

/** Busca por nome — devolve candidatos; a escolha usa guardas estritas (no chamador). */
export async function searchShows(query: string): Promise<TvMazeShow[]> {
  const rows = await tvMazeGet<{ score?: number; show?: TvMazeShow }[]>('/search/shows', { q: query })
  return (rows ?? []).flatMap((r) => (r.show ? [r.show] : []))
}

/** Todos os episódios de um show, incluindo especiais (temporada 0). */
export async function getShowEpisodes(showId: number): Promise<TvMazeEpisode[]> {
  const rows = await tvMazeGet<TvMazeEpisode[]>(`/shows/${showId}/episodes`, { specials: '1' })
  return rows ?? []
}

/**
 * O `summary` do TVMaze vem em HTML. Limpa para texto puro (o app não renderiza
 * HTML) e devolve `null` quando não sobra conteúdo.
 */
export function stripHtml(value?: string | null): string | null {
  if (!value) return null
  const text = value
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<\/p>/gi, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim()
  return text.length > 0 ? text : null
}
