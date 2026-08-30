import { unzipSync } from 'fflate'
import { env } from '../../../env'
import { canonicalLang, langLabel, toSubdlLangs } from '../lang'
import type { SubtitleProvider, SubtitleQuery, SubtitleResult } from '../types'

const API = 'https://api.subdl.com/api/v1/subtitles'
const DL = 'https://dl.subdl.com'

/** SubDL's film_name search is strict — "Dr. Stone: Science Future Part 3"
 *  matches 0 results while "Dr. Stone" matches the whole catalog. Build
 *  progressively shorter variants of the title so a suffix can't kill the
 *  search (verified 2026-08-30). */
function titleVariants(title: string): string[] {
  const t = title.trim()
  const variants = [t]
  // "Dr. Stone: Science Future Part 3" -> "Dr. Stone"
  const colon = t.indexOf(':')
  if (colon > 2) variants.push(t.slice(0, colon).trim())
  // "Dr. Stone - Science Future" -> "Dr. Stone"
  const dash = t.indexOf(' - ')
  if (dash > 2) variants.push(t.slice(0, dash).trim())
  // drop a trailing "Part N"/"Season N"/roman-numeral-ish suffix
  const stripped = t.replace(/\s+(?:part|season|s)\s*\d+$/i, '').trim()
  if (stripped && stripped !== t) variants.push(stripped)
  return Array.from(new Set(variants.filter((v) => v.length >= 3)))
}

export const subdlProvider: SubtitleProvider = {
  id: 'subdl',
  get enabled() {
    return !!env.SUBDL_API_KEY
  },

  async search(q: SubtitleQuery): Promise<SubtitleResult[]> {
    const p = new URLSearchParams()
    p.set('api_key', env.SUBDL_API_KEY!)
    // SubDL's season metadata is unreliable for anime (eps of a single season
    // are often tagged "season 2", verified 2026-08-30 with Tomb Raider King),
    // so we never filter by season_number — we search by title and filter the
    // returned episode range client-side (episode_from/episode/episode_end).
    p.set('languages', q.languages.flatMap(toSubdlLangs).join(','))
    p.set('subs_per_page', '30')
    if (q.type === 'series') {
      p.set('type', 'tv')
      if (q.episode != null) p.set('episode_number', String(q.episode))
    } else {
      p.set('type', 'movie')
    }
    if (q.tmdbId) p.set('tmdb_id', String(q.tmdbId))
    else if (q.imdbId) p.set('imdb_id', q.imdbId)
    else if (!q.title) return []

    const run = async (params: URLSearchParams): Promise<any[]> => {
      const res = await fetch(`${API}?${params.toString()}`)
      if (!res.ok) return []
      const json = (await res.json()) as any
      return (json?.subtitles ?? []) as any[]
    }

    let subs: any[] = []
    if (q.tmdbId || q.imdbId) {
      subs = await run(p)
      // id-index misses titles that a plain film_name search finds — fall back
      if (subs.length === 0 && q.title) {
        for (const variant of titleVariants(q.title)) {
          const p2 = new URLSearchParams(p)
          p2.delete('tmdb_id')
          p2.delete('imdb_id')
          p2.set('film_name', variant)
          subs = await run(p2)
          if (subs.length > 0) break
        }
      }
    } else {
      for (const variant of titleVariants(q.title!)) {
        const p2 = new URLSearchParams(p)
        p2.set('film_name', variant)
        subs = await run(p2)
        if (subs.length > 0) break
      }
    }

    const out = []
    for (const s of subs) {
      if (!s?.url) continue
      const canon = canonicalLang(s.language || s.lang)
      // Episode sanity check: when the client asked for a specific episode,
      // drop entries whose episode range clearly doesn't contain it. SubDL
      // tags anime with junk season numbers, so season is ignored here.
      if (q.type === 'series' && q.episode != null) {
        const from = Number(s.episode_from ?? s.episode ?? 0)
        const to = Number(s.episode_end ?? s.episode ?? 0)
        if (from > 0 && to > 0 && (q.episode < from || q.episode > to)) continue
      }
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
