import { unzipSync } from 'fflate'
import { env } from '../../../env'
import { canonicalLang, langLabel, toSubdlLang } from '../lang'
import type { SubtitleProvider } from '../types'

const API = 'https://api.subdl.com/api/v1/subtitles'
const DL = 'https://dl.subdl.com'

export const subdlProvider: SubtitleProvider = {
  id: 'subdl',
  get enabled() {
    return !!env.SUBDL_API_KEY
  },

  async search(q) {
    const p = new URLSearchParams()
    p.set('api_key', env.SUBDL_API_KEY!)
    p.set('languages', q.languages.map(toSubdlLang).join(','))
    p.set('subs_per_page', '30')
    if (q.type === 'series') {
      p.set('type', 'tv')
      if (q.season != null) p.set('season_number', String(q.season))
      if (q.episode != null) p.set('episode_number', String(q.episode))
    } else {
      p.set('type', 'movie')
    }
    if (q.tmdbId) p.set('tmdb_id', String(q.tmdbId))
    else if (q.imdbId) p.set('imdb_id', q.imdbId)
    else if (q.title) p.set('film_name', q.title)
    else return []

    const res = await fetch(`${API}?${p.toString()}`)
    if (!res.ok) return []
    const json = (await res.json()) as any
    const subs: any[] = json?.subtitles ?? []

    const out = []
    for (const s of subs) {
      if (!s?.url) continue
      const canon = canonicalLang(s.language || s.lang)
      out.push({
        provider: 'subdl',
        ref: s.url as string, // caminho do .zip
        lang: canon,
        langLabel: langLabel(canon),
        release: s.release_name || s.name || '',
        downloads: 0,
        rating: 0,
        hashMatch: false,
        hearingImpaired: !!s.hi,
        format: 'srt',
      })
    }
    return out
  },

  async fetchFile(ref) {
    const url = ref.startsWith('http') ? ref : DL + ref
    const res = await fetch(url)
    if (!res.ok) throw new Error(`subdl zip ${res.status}`)
    const zip = new Uint8Array(await res.arrayBuffer())
    const files = unzipSync(zip)
    const names = Object.keys(files)
    const name = names.find((n) => /\.(srt|vtt|ass)$/i.test(n)) ?? names[0]
    if (!name) throw new Error('subdl: zip vazio')
    return files[name]!
  },
}
