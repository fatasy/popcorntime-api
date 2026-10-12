import { load } from 'cheerio'
import { normalizeAnimeTitle, publicMediaUrl } from './animesdigital'
import type { AnimeAudioType, AnimeHttpEpisode, AnimeHttpRequest, ResolvedHttpStream } from './provider-types'

export const ANIMESONLINE_BASE = 'https://animesonline.cloud'
const MAX_HTML_BYTES = 4 * 1024 * 1024
const MAX_SEARCH_PAGES = 4
// Only probe the public media hosts advertised by this provider. Redirects use
// the same allowlist; a scraped URL cannot turn the API into a generic fetcher.
const MEDIA_HOSTS = new Set(['animeflix.blog', 'animes.click', 'aniplay.online', 'eos.feralhosting.com'])

function providerUrl(value: string, base = ANIMESONLINE_BASE): string | null {
  try {
    const url = new URL(value, base)
    if (url.origin !== ANIMESONLINE_BASE || url.username || url.password) return null
    url.hash = ''
    return url.href
  } catch { return null }
}

function mediaUrl(value: string, base?: string): string | null {
  const url = publicMediaUrl(value, base)
  return url && MEDIA_HOSTS.has(new URL(url).hostname) ? url : null
}

async function readHtml(pageUrl: string, signal?: AbortSignal): Promise<{ html: string; url: string }> {
  let url = providerUrl(pageUrl)
  if (!url) throw new Error('Página do AnimesOnline fora do provedor permitido')
  const requestSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000)
  for (let redirect = 0; redirect <= 4; redirect++) {
    const response: Response = await fetch(url, { redirect: 'manual', signal: requestSignal,
      headers: { Accept: 'text/html', 'User-Agent': 'fpopcorntime/1.4 anime-catalog' } })
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location')
      await response.body?.cancel()
      url = location ? providerUrl(location, url) : null
      if (!url) throw new Error('Redirecionamento do AnimesOnline inválido')
      continue
    }
    if (!response.ok) {
      await response.body?.cancel()
      throw new Error(`AnimesOnline HTTP ${response.status}`)
    }
    if (!/text\/html/i.test(response.headers.get('content-type') ?? '')) {
      await response.body?.cancel()
      throw new Error('AnimesOnline retornou conteúdo diferente de HTML')
    }
    const reader = response.body?.getReader()
    if (!reader) throw new Error('Página do AnimesOnline vazia')
    const decoder = new TextDecoder()
    let html = '', bytes = 0
    try {
      while (true) {
        const chunk = await reader.read()
        if (chunk.done) break
        bytes += chunk.value.byteLength
        if (bytes > MAX_HTML_BYTES) throw new Error('Página do AnimesOnline excedeu o limite de tamanho')
        html += decoder.decode(chunk.value, { stream: true })
      }
      html += decoder.decode()
    } finally { await reader.cancel() }
    if (/cf-chl-|just a moment|verify you are human/i.test(html)) throw new Error('AnimesOnline indisponível: verificação do site')
    return { html, url }
  }
  throw new Error('AnimesOnline excedeu o limite de redirecionamentos')
}

type AnimeHit = { url: string; title: string; audioType: AnimeAudioType }

export function parseAnimesOnlineSearch(html: string, titles: string[]): AnimeHit[] {
  const $ = load(html)
  const wanted = new Set(titles.map(normalizeAnimeTitle).filter(Boolean))
  const hits = new Map<string, AnimeHit>()
  $('.result-item .title a[href]').each((_, element) => {
    const title = $(element).text().trim()
    const url = providerUrl($(element).attr('href') ?? '')
    if (!url || !new URL(url).pathname.startsWith('/anime/') || !wanted.has(normalizeAnimeTitle(title))) return
    hits.set(url, { url, title, audioType: /dublado/i.test(title) ? 'dubbed' : 'subbed' })
  })
  return [...hits.values()]
}

export function parseAnimesOnlineEpisodes(html: string, hit: AnimeHit): AnimeHttpEpisode[] {
  const $ = load(html)
  // Dedicated season pages can themselves be labelled "Temporada 1". Do not
  // merge a later season with the first one if a page has multiple containers.
  const seasons = $('#seasons .se-c')
  const selector = '.episodios-grid .episode-card a[href], ul.episodios a[href]'
  const links = seasons.length ? seasons.first().find(selector) : $(selector)
  const episodes = new Map<string, AnimeHttpEpisode>()
  links.each((_, element) => {
    const url = providerUrl($(element).attr('href') ?? '', hit.url)
    if (!url || !new URL(url).pathname.startsWith('/episodio/')) return
    const number = new URL(url).pathname.match(/-episodio-(\d+)\/?$/)?.[1]
    const episode = Number(number)
    if (!Number.isSafeInteger(episode) || episode < 1) return
    const card = $(element).closest('.episode-card, li')
    const description = card.attr('data-episode-title') || card.find('.episode-title, .episodiotitle').text().trim()
    if (!episodes.has(url)) episodes.set(url, { provider: 'animesonline', pageUrl: url,
      title: `${hit.title} Episódio ${episode}${description ? ` · ${description}` : ''}`, episode, audioType: hit.audioType })
  })
  return [...episodes.values()].sort((a, b) => a.episode - b.episode)
}

export async function discoverAnimesOnline(request: AnimeHttpRequest, signal?: AbortSignal): Promise<AnimeHttpEpisode[]> {
  const hits = new Map<string, AnimeHit>()
  for (const title of [...new Set(request.titles.filter(Boolean))].slice(0, 3)) {
    // Search results are paginated and may place the dubbed edition on a later
    // page. A separate dubbed query keeps both editions discoverable.
    for (const query of [title, `${title} dublado`]) {
      if (new Set([...hits.values()].map((hit) => hit.audioType)).size === 2) break
      const firstUrl = `${ANIMESONLINE_BASE}/?${new URLSearchParams({ s: query })}`
      let nextUrl: string | null = firstUrl
      const visited = new Set<string>()
      for (let page = 0; nextUrl && page < MAX_SEARCH_PAGES && !visited.has(nextUrl); page++) {
        visited.add(nextUrl)
        const result = await readHtml(nextUrl, signal)
        const matches = parseAnimesOnlineSearch(result.html, request.titles)
        matches.forEach((hit) => hits.set(hit.url, hit))
        if (matches.length) break
        const $ = load(result.html)
        nextUrl = providerUrl($('.pagination a.next, .pagination a[rel="next"]').first().attr('href') ?? '', result.url)
        if (nextUrl && (nextUrl === result.url || new URL(nextUrl).searchParams.get('s') !== query)) nextUrl = null
      }
    }
    if (hits.size) break
  }
  const listings = await Promise.all([...hits.values()].slice(0, 4).map(async (hit) => {
    const page = await readHtml(hit.url, signal)
    return parseAnimesOnlineEpisodes(page.html, hit)
      .filter((episode) => request.targetEpisode == null || episode.episode === request.targetEpisode)
  }))
  return listings.flat().sort((a, b) => a.episode - b.episode || a.pageUrl.localeCompare(b.pageUrl))
}

export function extractAnimesOnlineStreams(html: string, pageUrl: string): ResolvedHttpStream[] {
  const $ = load(html)
  const streams = new Map<string, ResolvedHttpStream>()
  $('.animeq-player video[src], .animeq-player video source[src], .animeq-player [data-video-src]').each((_, element) => {
    const node = $(element)
    const url = mediaUrl(node.attr('data-video-src') ?? node.attr('src') ?? '', pageUrl)
    if (!url || !/\.(mp4|m3u8|webm)$/i.test(new URL(url).pathname)) return
    const label = node.attr('label') ?? node.attr('data-video-title') ?? null
    const quality = label ? /FHD|Full\s*HD|1080/i.test(label) ? '1080p'
      : /720|^HD$/i.test(label) ? '720p' : /480|^SD$/i.test(label) ? '480p' : null : null
    const mimeType = /\.m3u8$/i.test(new URL(url).pathname) ? 'application/vnd.apple.mpegurl'
      : /\.webm$/i.test(new URL(url).pathname) ? 'video/webm' : 'video/mp4'
    if (!streams.has(url)) streams.set(url, { url, quality, mimeType })
  })
  return [...streams.values()]
}

async function probeStream(stream: ResolvedHttpStream, signal: AbortSignal): Promise<ResolvedHttpStream> {
  let url = stream.url
  for (let redirect = 0; redirect <= 4; redirect++) {
    // HEAD only: never request a video, playlist or segment body on the API.
    const response = await fetch(url, { method: 'HEAD', redirect: 'manual', signal })
    await response.body?.cancel()
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location')
      const next = location ? mediaUrl(location, url) : null
      if (!next) throw new Error('Redirecionamento da CDN do AnimesOnline inválido')
      url = next
      continue
    }
    if (!response.ok) throw new Error(`CDN HTTP ${response.status}`)
    const contentType = response.headers.get('content-type')?.split(';')[0]?.trim()
    if (!/^(?:video\/(?:mp4|webm)|application\/(?:vnd\.apple\.mpegurl|x-mpegurl)|audio\/mpegurl)$/i.test(contentType ?? '')) {
      throw new Error('CDN do AnimesOnline não respondeu com mídia compatível')
    }
    return { ...stream, url, mimeType: /mpegurl/i.test(contentType!) ? 'application/vnd.apple.mpegurl' : contentType }
  }
  throw new Error('CDN do AnimesOnline excedeu o limite de redirecionamentos')
}

export async function resolveAnimesOnline(pageUrl: string): Promise<ResolvedHttpStream> {
  const parsed = providerUrl(pageUrl)
  if (!parsed || !/^\/episodio\/[^/]+\/?$/.test(new URL(parsed).pathname)) throw new Error('Referência do AnimesOnline inválida')
  const page = await readHtml(parsed)
  const streams = extractAnimesOnlineStreams(page.html, page.url).slice(0, 6)
  if (!streams.length) throw new Error('AnimesOnline: episódio sem URL HTTP direta compatível')
  const controller = new AbortController()
  try {
    return await Promise.any(streams.map((stream) => probeStream(stream,
      AbortSignal.any([controller.signal, AbortSignal.timeout(8_000)]))))
  } catch {
    throw new Error('AnimesOnline: nenhum servidor de vídeo disponível para este episódio/áudio')
  } finally { controller.abort() }
}
