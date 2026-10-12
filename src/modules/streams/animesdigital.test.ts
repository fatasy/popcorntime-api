import { test } from 'node:test'
import assert from 'node:assert/strict'
import { discoverAnimesDigital, extractAnimeStream, parseAnimeEpisodes, parseAnimeSearch,
  publicMediaUrl, resolveAnimesDigital } from './animesdigital'
import { mergeHttpEpisodeSources } from './episodes'

const BASE = 'https://animesdigital.org'
const searchHtml = `<div class="itemA"><a href="/anime/a/example"><span class="title_anime">Example</span></a></div>
  <div class="itemA"><a href="/anime/a/example-dub"><span class="title_anime">Example Dublado</span></a></div>
  <div class="itemA"><a href="/anime/a/example-2"><span class="title_anime">Example 2</span></a></div>
  <div class="itemA"><a href="https://evil.example/anime/a/example"><span class="title_anime">Example</span></a></div>`
const listing = (number: number, suffix = '') => `<a href="/video/a/${number}${suffix}"><div class="title_anime">Example Episódio ${number}</div></a>`
const streamPage = `<iframe src="https://api.anivideo.net/videohls.php?d=https%3A%2F%2Fcdn.example.com%2Fvideo%2Findex.m3u8%3Ftoken%3Dfresh&amp;nocache=123"></iframe>`

async function withPages(pages: Record<string, string | Response>, run: (requests: string[]) => Promise<void>) {
  const original = globalThis.fetch
  const requests: string[] = []
  globalThis.fetch = Object.assign(async (input: string | URL | Request) => {
    const url = String(input)
    requests.push(url)
    const page = pages[url]
    assert.ok(page, `unexpected fetch: ${url}`)
    return typeof page === 'string' ? new Response(page, { headers: { 'content-type': 'text/html' } }) : page
  }, { preconnect: original.preconnect }) as typeof fetch
  try { await run(requests) } finally { globalThis.fetch = original }
}

test('busca distingue a obra, sequelas e ambas as versões de áudio', () => {
  const hits = parseAnimeSearch(searchHtml, ['Éxample'])
  assert.deepEqual(hits.map((hit) => hit.audioType).sort(), ['dubbed', 'subbed'])
  assert.ok(hits.every((hit) => !hit.url.includes('example-2') && hit.url.startsWith(BASE)))
})

test('episódios ignoram navegação, comentários, decimais e links externos', () => {
  const html = listing(12) + listing(12) + `<a href="/video/a/13">Example Episódio 12.5</a>
    <a href="/video/a/10">Anterior</a><a href="https://evil.example/video/a/11">Episódio 11</a>`
  const parsed = parseAnimeEpisodes(html, `${BASE}/anime/a/example`, 'dubbed')
  assert.deepEqual(parsed.episodes.map((ep) => [ep.episode, ep.audioType]), [[12, 'dubbed']])
})

test('temporadas e partes equivalentes casam sem confundir números diferentes', () => {
  const html = `<a href="/anime/a/example-2"><span class="title_anime">Example Season ll Dublado</span></a>
    <a href="/anime/a/example-part-2"><span class="title_anime">Example Parte 2</span></a>
    <a href="/anime/a/example-3"><span class="title_anime">Example Season 3</span></a>`
  assert.equal(parseAnimeSearch(html, ['Example 2nd Season']).length, 1)
  assert.equal(parseAnimeSearch(html, ['Example Part 2'])[0]?.url, `${BASE}/anime/a/example-part-2`)
})

test('extrai HLS anunciado no iframe sem carregar player, manifesto ou vídeo', async () => {
  await withPages({ [`${BASE}/video/a/1`]: streamPage }, async (requests) => {
    const stream = await resolveAnimesDigital(`${BASE}/video/a/1`)
    assert.equal(stream.url, 'https://cdn.example.com/video/index.m3u8?token=fresh')
    assert.equal(requests.length, 1)
  })
})

test('MP4 direto é aceito, páginas HTML com extensão mp4 não viram stream', () => {
  assert.equal(extractAnimeStream('<video><source src="https://cdn.example.com/v.mp4" label="720p"></video>', BASE)?.quality, '720p')
  assert.equal(extractAnimeStream('<iframe src="https://animesdigital.org/embed/bg.mp4"></iframe>', BASE), null)
})

test('recusa protocolos, credenciais e destinos locais', () => {
  for (const url of ['file:///v.mp4', 'javascript:alert(1)', 'https://user:pass@cdn.example.com/v.mp4',
    'http://127.0.0.1/v.mp4', 'http://192.168.1.2/v.mp4', 'http://[::1]/v.mp4', 'http://localhost/v.mp4']) {
    assert.equal(publicMediaUrl(url), null)
  }
})

test('paginação busca páginas intermediárias e preserva as duas versões', async () => {
  const pages: Record<string, string> = { [`${BASE}/pesquisa/Example/`]: searchHtml }
  for (const suffix of ['', '-dub']) {
    const animeUrl = `${BASE}/anime/a/example${suffix}`
    pages[animeUrl] = listing(3, suffix) + `<a href="${animeUrl}/page/3/">3</a>`
    pages[`${animeUrl}/page/2/`] = listing(2, suffix)
    pages[`${animeUrl}/page/3/`] = listing(1, suffix)
  }
  await withPages(pages, async (requests) => {
    const episodes = await discoverAnimesDigital(['Example'], 2)
    assert.equal(episodes.length, 2)
    assert.ok(episodes.every((ep) => ep.episode === 2))
    assert.ok(requests.includes(`${BASE}/anime/a/example/page/2/`))
    assert.ok(requests.every((url) => !url.includes('/video/')))
  })
})

test('redirecionamento para fora do provedor falha sem consultar o destino', async () => {
  await withPages({ [`${BASE}/video/a/1`]: new Response('', { status: 302, headers: { location: 'http://127.0.0.1/private' } }) }, async (requests) => {
    await assert.rejects(resolveAnimesDigital(`${BASE}/video/a/1`), /Redirecionamento/)
    assert.equal(requests.length, 1)
  })
})

test('HTTP 429 e conteúdo de mídia retornam erro sem ler a mídia', async () => {
  await withPages({ [`${BASE}/video/a/1`]: new Response('', { status: 429 }) }, async () => {
    await assert.rejects(resolveAnimesDigital(`${BASE}/video/a/1`), /HTTP 429/)
  })
  const media = new Response('video bytes', { headers: { 'content-type': 'video/mp4' } })
  Object.defineProperty(media.body, 'getReader', { value: () => assert.fail('não deve ler o corpo de mídia') })
  await withPages({ [`${BASE}/video/a/1`]: media }, async () => {
    await assert.rejects(resolveAnimesDigital(`${BASE}/video/a/1`), /diferente de HTML/)
    assert.equal(media.bodyUsed, true) // corpo cancelado, sem abrir um reader
  })
})

test('mescla referências HTTP sem perder metadados e torrents, inclusive fora do catálogo externo', () => {
  const stream = { id: 1, content_id: 7, season: 2, episode: 13, provider: 'animesdigital', page_url: `${BASE}/video/a/13`,
    title: 'Example Parte 2 Episódio 1', audio_type: 'dubbed', stream_url: null, quality: null, resolved_at: null, collected_at: new Date(0) }
  const existing = { season: 2, episode: 13, title: 'Título do episódio', air_date: '2026-10-01', torrents: [], filler: true }
  const merged = mergeHttpEpisodeSources([existing], [stream, { ...stream, id: 2, episode: 14 }])
  assert.equal(merged.length, 2)
  assert.equal(merged[0]?.title, existing.title)
  assert.equal(merged[0]?.filler, true)
  assert.equal(merged[0]?.streams?.[0]?.id, 1)
  assert.equal(merged[1]?.episode, 14)
})
