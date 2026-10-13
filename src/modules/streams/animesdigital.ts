import { load } from 'cheerio'
import type { AnimeHttpEpisode } from './provider-types'
import { animeSourceQueries } from './title-aliases'
export type { AnimeHttpEpisode } from './provider-types'

export const ANIMESDIGITAL_BASE = 'https://animesdigital.org'
const MAX_PAGES = 32
const MAX_HTML_BYTES = 4 * 1024 * 1024

export function normalizeAnimeTitle(title: string): string {
  return title.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/\b(?:dublado|legendado|todos os episodios|online|assistir)\b/g, '')
    .replace(/\b(\d+)(?:st|nd|rd|th)\s+season\b/g, 'season $1')
    .replace(/\b(\d+)(?:a|o)?\s+temporada\b/g, 'season $1')
    .replace(/\b(season|temporada|part|parte)\s*([ivx]+|ll|\d+)\b/g, (_, kind: string, value: string) => {
      const roman: Record<string, number> = { ii: 2, ll: 2, iii: 3, iv: 4, v: 5, vi: 6, vii: 7, viii: 8, ix: 9, x: 10 }
      const number = /^\d+$/.test(value) ? Number(value) : roman[value]
      return number ? `${/season|temporada/.test(kind) ? 'season' : 'part'} ${number}` : `${kind} ${value}`
    })
    .replace(/[^a-z0-9]+/g, ' ').trim().replace(/\s+/g, ' ')
}

function providerUrl(value: string, base = ANIMESDIGITAL_BASE): string | null {
  try {
    const url = new URL(value, base)
    if (url.origin !== ANIMESDIGITAL_BASE || url.username || url.password) return null
    url.hash = ''
    return url.href
  } catch { return null }
}

/** Valida o link devolvido ao player; este módulo nunca faz GET da mídia. */
export function publicMediaUrl(value: string, base?: string): string | null {
  try {
    const url = new URL(value, base)
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return null
    const host = url.hostname.toLowerCase()
    if (host === 'localhost' || !host.includes('.') || host.endsWith('.local') ||
      /^127\.|^10\.|^0\.|^169\.254\.|^192\.168\.|^172\.(?:1[6-9]|2\d|3[01])\./.test(host) ||
      host.startsWith('[')) return null
    return url.href
  } catch { return null }
}

async function readHtml(pageUrl: string, signal?: AbortSignal): Promise<{ html: string; url: string }> {
  let url = providerUrl(pageUrl)
  if (!url) throw new Error('Página de anime fora do provedor permitido')
  for (let redirect = 0; redirect <= 4; redirect++) {
    const res: Response = await fetch(url, {
      redirect: 'manual', signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000),
      headers: { Accept: 'text/html', 'User-Agent': 'fpopcorntime/1.4 anime-catalog' },
    })
    if (res.status >= 300 && res.status < 400) {
      const location: string | null = res.headers.get('location')
      await res.body?.cancel()
      url = location ? providerUrl(location, url) : null
      if (!url) throw new Error('Redirecionamento de anime inválido')
      continue
    }
    if (!res.ok) {
      await res.body?.cancel()
      throw new Error(`AnimesDigital HTTP ${res.status}`)
    }
    // Não ler manifestos, segmentos nem arquivos de vídeo, mesmo se o site mudar.
    if (!/text\/html/i.test(res.headers.get('content-type') ?? '')) {
      await res.body?.cancel()
      throw new Error('AnimesDigital retornou conteúdo diferente de HTML')
    }
    const reader = res.body?.getReader()
    if (!reader) throw new Error('Página de anime vazia')
    const decoder = new TextDecoder()
    let html = '', bytes = 0
    try {
      while (true) {
        const chunk = await reader.read()
        if (chunk.done) break
        bytes += chunk.value.byteLength
        if (bytes > MAX_HTML_BYTES) throw new Error('Página de anime excedeu o limite de tamanho')
        html += decoder.decode(chunk.value, { stream: true })
      }
      html += decoder.decode()
    } finally { await reader.cancel() }
    if (/cf-chl-|just a moment|verify you are human/i.test(html)) {
      throw new Error('AnimesDigital indisponível: verificação do site')
    }
    return { html, url }
  }
  throw new Error('AnimesDigital excedeu o limite de redirecionamentos')
}

export function parseAnimeSearch(html: string, titles: string[]): { url: string; title: string; audioType: 'dubbed' | 'subbed' }[] {
  const $ = load(html)
  const wanted = new Set(titles.map(normalizeAnimeTitle).filter(Boolean))
  const hits = new Map<string, { url: string; title: string; audioType: 'dubbed' | 'subbed' }>()
  $('.itemA a[href], a[href*="/anime/"]').each((_, el) => {
    const title = $(el).find('.title_anime').text().trim() || $(el).text().trim()
    const url = providerUrl($(el).attr('href') ?? '')
    if (!url || !new URL(url).pathname.startsWith('/anime/') || !wanted.has(normalizeAnimeTitle(title))) return
    hits.set(url, { url, title, audioType: /dublado/i.test(title) ? 'dubbed' : 'subbed' })
  })
  return [...hits.values()]
}

export function parseAnimeEpisodes(html: string, pageUrl: string, audioType: 'dubbed' | 'subbed'): {
  episodes: AnimeHttpEpisode[]; pages: string[]
} {
  const $ = load(html)
  const episodes = new Map<number, AnimeHttpEpisode>()
  $('a[href*="/video/"]').each((_, el) => {
    const title = $(el).find('.title_anime').text().trim() || $(el).text().replace(/\s+/g, ' ').trim()
    const number = title.match(/epis[oó]dio\s*(\d+)(?![\d.])/i)?.[1]
    const episode = number ? Number(number) : 0
    const url = providerUrl($(el).attr('href') ?? '', pageUrl)
    if (!url || !new URL(url).pathname.startsWith('/video/') || !Number.isSafeInteger(episode) || episode < 1) return
    episodes.set(episode, { provider: 'animesdigital', pageUrl: url, title, episode, audioType })
  })
  const seriesPath = new URL(pageUrl).pathname.replace(/\/page\/\d+\/?$/, '').replace(/\/$/, '')
  const pages = new Set<string>()
  $('a[href*="/page/"]').each((_, el) => {
    const url = providerUrl($(el).attr('href') ?? '', pageUrl)
    if (url && new URL(url).pathname.startsWith(`${seriesPath}/page/`)) pages.add(url)
  })
  return { episodes: [...episodes.values()], pages: [...pages] }
}

export function extractAnimeStream(html: string, pageUrl: string): { url: string; quality: string | null } | null {
  const $ = load(html)
  for (const el of $('iframe[src]').toArray()) {
    try {
      const embed = new URL($(el).attr('src')!, pageUrl)
      // O player público anuncia a URL HLS em d; não precisamos carregar o iframe.
      if (embed.hostname !== 'api.anivideo.net' || embed.pathname !== '/videohls.php') continue
      const url = publicMediaUrl(embed.searchParams.get('d') ?? '')
      if (url && /\.m3u8$/i.test(new URL(url).pathname)) return { url, quality: null }
    } catch { /* outro player do site */ }
  }
  for (const el of $('video[src], video source[src]').toArray()) {
    const url = publicMediaUrl($(el).attr('src') ?? '', pageUrl)
    if (url && /\.(mp4|m3u8|webm)$/i.test(new URL(url).pathname)) {
      return { url, quality: $(el).attr('label') ?? null }
    }
  }
  return null
}

export async function discoverAnimesDigital(titles: string[], targetEpisode?: number, signal?: AbortSignal): Promise<AnimeHttpEpisode[]> {
  const queries = animeSourceQueries(titles)
  let hits: ReturnType<typeof parseAnimeSearch> = []
  for (const title of queries) {
    const search = await readHtml(`${ANIMESDIGITAL_BASE}/pesquisa/${encodeURIComponent(title)}/`, signal)
    hits = parseAnimeSearch(search.html, titles)
    if (hits.length) break
  }
  const found = new Map<string, AnimeHttpEpisode>()
  for (const hit of hits.slice(0, 4)) {
    const listing = await readHtml(hit.url, signal)
    const first = parseAnimeEpisodes(listing.html, listing.url, hit.audioType)
    const append = (items: AnimeHttpEpisode[]) => {
      for (const item of items) if (targetEpisode == null || item.episode === targetEpisode) {
        found.set(item.pageUrl, item)
      }
    }
    append(first.episodes)
    if (targetEpisode != null && first.episodes.some((ep) => ep.episode === targetEpisode)) continue
    // O site pagina 50 episódios. Percorre também as páginas intermediárias,
    // que não aparecem individualmente nos links da paginação.
    const lastPage = Math.max(1, ...first.pages.map((url) => Number(url.match(/\/page\/(\d+)/)?.[1]) || 1))
    const base = listing.url.replace(/\/page\/\d+\/?$/, '').replace(/\/$/, '')
    for (let page = 2; page <= Math.min(lastPage, MAX_PAGES); page += 3) {
      const pages = await Promise.all(Array.from({ length: Math.min(3, Math.min(lastPage, MAX_PAGES) - page + 1) }, async (_, i) => {
        const next = await readHtml(`${base}/page/${page + i}/`, signal)
        return parseAnimeEpisodes(next.html, next.url, hit.audioType).episodes
      }))
      pages.forEach(append)
      if (targetEpisode != null && pages.some((items) => items.some((ep) => ep.episode === targetEpisode))) break
    }
    if (targetEpisode == null && lastPage > MAX_PAGES) throw new Error('AnimesDigital: catálogo excede o limite de paginação')
  }
  return [...found.values()].sort((a, b) => a.episode - b.episode || a.pageUrl.localeCompare(b.pageUrl))
}

export async function resolveAnimesDigital(pageUrl: string): Promise<{ url: string; quality: string | null }> {
  const page = await readHtml(pageUrl)
  const stream = extractAnimeStream(page.html, page.url)
  if (!stream) throw new Error('Este episódio não expõe uma URL HTTP direta compatível')
  return stream
}
