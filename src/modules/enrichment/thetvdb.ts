// TheTVDB v4 — API OFICIAL (https://api4.thetvdb.com/v4).
// Fornece arte POR EPISÓDIO (campo `image`, URL completa) e numeração
// `absoluteNumber` (útil em anime multi-temporada).
//
// ⚠️ PROVEDOR OPCIONAL E NÃO EXERCITADO CONTRA A API REAL: exige
// `THETVDB_API_KEY`. Sem a chave `theTvdbConfigured()` é false e NENHUMA
// chamada acontece — o módulo foi escrito a partir da especificação oficial
// (github.com/thetvdb/v4-api → docs/swagger.yml, v4.7.10) e validado apenas por
// tipagem. Antes de ligar em produção: (a) revisar os termos/licença
// (thetvdb.com/api-information: grátis para receita < US$50k/ano, COM
// atribuição e link direto para TheTVDB.com; acima disso há taxa anual) e
// (b) exercitar com uma chave real.
//
// Endpoints usados (v4):
//   POST /login                                 {apikey} → { data: { token } }
//   GET  /search/remoteid/{imdb}                → { data: [ { series: SeriesBaseRecord } ] }
//   GET  /search?query=&type=series&limit=      → { data: [ SearchResult ] }
//   GET  /series/{id}/episodes/default?page=0   → { data: { series, episodes: [EpisodeBaseRecord] } }
import { env } from '../../env'

const BASE = 'https://api4.thetvdb.com/v4'
const REQUEST_TIMEOUT_MS = 15_000
/** O token v4 vale ~1 mês; renovamos bem antes disso. */
const TOKEN_TTL_MS = 20 * 60 * 60 * 1000
/** Teto de páginas do endpoint de episódios (uma série longa cabe em 1-2). */
const EPISODE_PAGE_LIMIT = 4

/** O provedor só participa quando existe chave configurada. */
export function theTvdbConfigured(): boolean {
  return Boolean(env.THETVDB_API_KEY)
}

let token: { value: string; expiresAt: number } | null = null

async function login(): Promise<string> {
  const res = await fetch(BASE + '/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ apikey: env.THETVDB_API_KEY }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
  if (!res.ok) throw new Error('TheTVDB login HTTP ' + res.status)
  const json = (await res.json()) as { data?: { token?: string } }
  const value = json.data?.token
  if (!value) throw new Error('TheTVDB login sem token na resposta')
  return value
}

async function authToken(force = false): Promise<string> {
  if (!force && token && token.expiresAt > Date.now()) return token.value
  const value = await login()
  token = { value, expiresAt: Date.now() + TOKEN_TTL_MS }
  return value
}

/**
 * GET autenticado. `null` = 404 (ausência definitiva na fonte). 401 renova o
 * token e tenta uma vez. Qualquer outro status/erro é lançado (o chamador
 * marca a falha e re-tenta depois).
 */
async function tvdbGet<T>(
  path: string,
  params: Record<string, string> = {},
  retry = true,
): Promise<T | null> {
  const bearer = await authToken()
  const url = new URL(BASE + path)
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v)
  const res = await fetch(url, {
    headers: { accept: 'application/json', authorization: 'Bearer ' + bearer },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
  if (res.status === 404) return null
  if (res.status === 401 && retry) {
    await authToken(true)
    return tvdbGet<T>(path, params, false)
  }
  if (!res.ok) throw new Error('TheTVDB ' + res.status + ' on ' + path)
  return (await res.json()) as T
}

export interface TvdbSearchResult {
  id?: string | null
  tvdb_id?: string | null
  name?: string | null
  name_translated?: string | null
  title?: string | null
  year?: string | null
  type?: string | null
  primary_language?: string | null
  first_air_time?: string | null
}

export interface TvdbEpisode {
  id?: number | null
  name?: string | null
  overview?: string | null
  number?: number | null
  seasonNumber?: number | null
  absoluteNumber?: number | null
  aired?: string | null
  runtime?: number | null
  image?: string | null
}

/** Id numérico do series (a API aceita o id "puro"; removemos prefixos tipo "series-"). */
export function tvdbNumericId(value?: string | null): number | null {
  if (!value) return null
  const n = Number(value.replace(/^[a-z]+-/i, ''))
  return Number.isFinite(n) && n > 0 ? n : null
}

/** Series id a partir do IMDb id — vínculo por id externo confiável. */
export async function findSeriesIdByImdb(imdbId: string): Promise<number | null> {
  const json = await tvdbGet<{ data?: { series?: { id?: number | null } | null }[] }>(
    '/search/remoteid/' + encodeURIComponent(imdbId),
  )
  for (const item of json?.data ?? []) {
    const id = item?.series?.id
    if (typeof id === 'number' && id > 0) return id
  }
  return null
}

/** Candidatos por nome — a escolha com guardas estritas é feita pelo chamador. */
export async function searchSeries(query: string): Promise<TvdbSearchResult[]> {
  const json = await tvdbGet<{ data?: TvdbSearchResult[] }>('/search', {
    query,
    type: 'series',
    limit: '10',
  })
  return json?.data ?? []
}

/** Episódios do series na ordem de temporada padrão (paginado). */
export async function getSeriesEpisodes(seriesId: number): Promise<TvdbEpisode[]> {
  const out: TvdbEpisode[] = []
  for (let page = 0; page < EPISODE_PAGE_LIMIT; page++) {
    const json = await tvdbGet<{ data?: { episodes?: TvdbEpisode[] } }>(
      '/series/' + seriesId + '/episodes/default',
      { page: String(page) },
    )
    const episodes = json?.data?.episodes ?? []
    if (episodes.length === 0) break
    out.push(...episodes)
  }
  return out
}
