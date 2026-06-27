import { env } from '../../../env'
import { canonicalLang, langLabel, toOpenSubtitlesLang } from '../lang'
import type { SubtitleProvider } from '../types'

const BASE = 'https://api.opensubtitles.com/api/v1'

function headers(extra?: Record<string, string>): Record<string, string> {
  return {
    'Api-Key': env.OPENSUBTITLES_API_KEY ?? '',
    'User-Agent': env.OPENSUBTITLES_APP_NAME,
    Accept: 'application/json',
    ...extra,
  }
}

// JWT opcional (login eleva a cota diária de downloads). Cacheado em memória.
let jwt: string | null = null
let jwtAt = 0
async function getToken(): Promise<string | null> {
  if (!env.OPENSUBTITLES_USERNAME || !env.OPENSUBTITLES_PASSWORD) return null
  if (jwt && Date.now() - jwtAt < 23 * 60 * 60 * 1000) return jwt
  try {
    const res = await fetch(`${BASE}/login`, {
      method: 'POST',
      headers: headers({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({
        username: env.OPENSUBTITLES_USERNAME,
        password: env.OPENSUBTITLES_PASSWORD,
      }),
    })
    if (!res.ok) return null
    const data = (await res.json()) as any
    jwt = data?.token ?? null
    jwtAt = Date.now()
    return jwt
  } catch {
    return null
  }
}

function imdbNumeric(imdb?: string): string | undefined {
  if (!imdb) return undefined
  const n = imdb.replace(/^tt/i, '').replace(/^0+/, '')
  return n || undefined
}

export const openSubtitlesProvider: SubtitleProvider = {
  id: 'opensubtitles',
  get enabled() {
    return !!env.OPENSUBTITLES_API_KEY
  },

  async search(q) {
    const p = new URLSearchParams()
    p.set('languages', q.languages.map(toOpenSubtitlesLang).join(','))
    p.set('order_by', 'download_count')

    if (q.type === 'series') {
      p.set('type', 'episode')
      if (q.tmdbId) p.set('parent_tmdb_id', String(q.tmdbId))
      else if (q.imdbId) p.set('parent_imdb_id', imdbNumeric(q.imdbId)!)
      if (q.season != null) p.set('season_number', String(q.season))
      if (q.episode != null) p.set('episode_number', String(q.episode))
    } else {
      p.set('type', 'movie')
      if (q.tmdbId) p.set('tmdb_id', String(q.tmdbId))
      else if (q.imdbId) p.set('imdb_id', imdbNumeric(q.imdbId)!)
    }

    const hasId = ['tmdb_id', 'imdb_id', 'parent_tmdb_id', 'parent_imdb_id'].some((k) => p.has(k))
    if (!hasId) {
      if (q.title) p.set('query', q.title)
      else return []
    }

    const res = await fetch(`${BASE}/subtitles?${p.toString()}`, { headers: headers() })
    if (!res.ok) return []
    const json = (await res.json()) as any
    const data: any[] = json?.data ?? []

    const out = []
    for (const item of data) {
      const a = item?.attributes
      const file = a?.files?.[0]
      if (!a || !file?.file_id) continue
      const canon = canonicalLang(a.language)
      out.push({
        provider: 'opensubtitles',
        ref: String(file.file_id),
        lang: canon,
        langLabel: langLabel(canon),
        release: a.release || file.file_name || '',
        downloads: a.download_count ?? 0,
        rating: a.ratings ?? 0,
        hashMatch: !!a.moviehash_match,
        hearingImpaired: !!a.hearing_impaired,
        format: 'srt',
      })
    }
    return out
  },

  async fetchFile(ref) {
    const token = await getToken()
    const res = await fetch(`${BASE}/download`, {
      method: 'POST',
      headers: headers({
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      }),
      body: JSON.stringify({ file_id: Number(ref) }),
    })
    if (!res.ok) throw new Error(`opensubtitles /download ${res.status}`)
    const json = (await res.json()) as any
    const link: string | undefined = json?.link
    if (!link) throw new Error('opensubtitles: link de download ausente')
    const fileRes = await fetch(link, { headers: { 'User-Agent': env.OPENSUBTITLES_APP_NAME } })
    if (!fileRes.ok) throw new Error(`opensubtitles file ${fileRes.status}`)
    return new Uint8Array(await fileRes.arrayBuffer())
  },
}
