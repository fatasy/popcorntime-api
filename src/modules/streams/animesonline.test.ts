import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ANIMESONLINE_BASE, discoverAnimesOnline, extractAnimesOnlineStreams,
  parseAnimesOnlineEpisodes, parseAnimesOnlineSearch, resolveAnimesOnline } from './animesonline'

const BASE = ANIMESONLINE_BASE
const result = (slug: string, title: string) => `<div class="result-item"><article>
  <div class="title"><a href="/anime/${slug}">${title}</a></div></article></div>`
const search = result('example', 'Example – Todos os Episódios') + result('example-dub', 'Example Dublado')
  + result('example-2', 'Example 2nd Season') + result('example-movie', 'Example Movie')
const card = (slug: string, episode: string, description = 'Um novo dia') => `<div class="episode-card" data-episode-title="${description}">
  <a href="/episodio/${slug}-episodio-${episode}">Imagem</a><h3 class="episode-title"><a href="/episodio/${slug}-episodio-${episode}">${description}</a></h3>
  <a class="episode-mini-number" href="/episodio/${slug}-episodio-${episode}">${episode}</a></div>`
const listing = (slug: string) => `<div id="seasons"><div class="se-c"><div class="episodios-grid">${card(slug, '01')}${card(slug, '02')}</div></div></div>`
const episodePage = (sources: string) => `<section class="animeq-player">${sources}</section>`
const blocked = 'https://animes.click/Example/Dub/01.mp4'
const playable = 'https://animeflix.blog/Example/Dub/01.mp4'

async function withFetch(pages: Record<string, string | (() => Response)>, run: (requests: { url: string; method: string }[]) => Promise<void>) {
  const original = globalThis.fetch
  const requests: { url: string; method: string }[] = []
  globalThis.fetch = Object.assign(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input), method = init?.method ?? 'GET'
    requests.push({ url, method })
    const page = pages[`${method} ${url}`]
    assert.ok(page, `unexpected fetch: ${method} ${url}`)
    return typeof page === 'string' ? new Response(page, { headers: { 'content-type': 'text/html' } }) : page()
  }, { preconnect: original.preconnect }) as typeof fetch
  try { await run(requests) } finally { globalThis.fetch = original }
}

test('AnimesOnline distingue ambas as versões, sequelas, filmes e links externos', () => {
  const html = search + result('external', 'Other') + `<div class="result-item"><div class="title">
    <a href="https://evil.example/anime/example">Example</a></div></div>`
  assert.deepEqual(parseAnimesOnlineSearch(html, ['Éxample']).map((hit) => hit.audioType), ['subbed', 'dubbed'])
  assert.equal(parseAnimesOnlineSearch(html, ['Example Season II'])[0]?.url, `${BASE}/anime/example-2`)
})

test('AnimesOnline identifica números pela URL, preserva áudio e ignora duplicatas, decimais e outras temporadas', () => {
  const hit = { url: `${BASE}/anime/example-dub`, title: 'Example Dublado', audioType: 'dubbed' as const }
  const html = `<div id="seasons"><div class="se-c"><div class="episodios-grid">
    ${card('example-dub', '01')}${card('example-dub', '12.5')}${card('example-dub', '00')}
    <div class="episode-card"><a href="https://evil.example/episodio/example-episodio-03">Episódio 3</a></div>
    </div></div><div class="se-c"><div class="episodios-grid">${card('other-season', '01')}</div></div></div>`
  const episodes = parseAnimesOnlineEpisodes(html, hit)
  assert.equal(episodes.length, 1)
  assert.equal(episodes[0]?.episode, 1)
  assert.equal(episodes[0]?.audioType, 'dubbed')
  assert.ok(episodes[0]?.title.includes('Um novo dia'))
})

test('AnimesOnline busca a edição dublada separadamente e coleta somente o episódio solicitado', async () => {
  await withFetch({
    [`GET ${BASE}/?s=Example`]: result('example', 'Example'),
    [`GET ${BASE}/?s=Example+dublado`]: result('example-dub', 'Example Dublado'),
    [`GET ${BASE}/anime/example`]: listing('example'),
    [`GET ${BASE}/anime/example-dub`]: listing('example-dub'),
  }, async (requests) => {
    const episodes = await discoverAnimesOnline({ titles: ['Example'], targetEpisode: 2 })
    assert.deepEqual(episodes.map((episode) => episode.audioType).sort(), ['dubbed', 'subbed'])
    assert.ok(episodes.every((episode) => episode.episode === 2 && episode.provider === 'animesonline'))
    assert.ok(requests.every((request) => request.method === 'GET' && !request.url.includes('/episodio/')))
  })
})

test('AnimesOnline percorre a paginação da busca sem confundir resultados e recomendações', async () => {
  await withFetch({
    [`GET ${BASE}/?s=Example`]: result('example-2', 'Example 2') + `<div class="pagination"><a class="next" href="/page/2/?s=Example">2</a></div>`,
    [`GET ${BASE}/page/2/?s=Example`]: search,
    [`GET ${BASE}/anime/example`]: listing('example'),
    [`GET ${BASE}/anime/example-dub`]: listing('example-dub'),
  }, async (requests) => {
    assert.equal((await discoverAnimesOnline({ titles: ['Example'] })).length, 4)
    assert.ok(requests.some((request) => request.url.includes('/page/2/')))
  })
})

test('AnimesOnline extrai MP4 e HLS diretos, com qualidade, sem seguir iframes ou aceitar hosts arbitrários', () => {
  const html = episodePage(`<video><source src="${playable}" type="video/mp4"></video>
    <div data-video-src="https://animeflix.blog/Example/index.m3u8" data-video-title="FullHD / HLS"></div>
    <video src="http://127.0.0.1/private.mp4"></video><video src="https://unlisted.example/video.mp4"></video>
    <iframe src="https://www.blogger.com/video.g?token=private"></iframe>`)
  const streams = extractAnimesOnlineStreams(html, BASE)
  assert.equal(streams.length, 2)
  assert.equal(streams[0]?.mimeType, 'video/mp4')
  assert.equal(streams[1]?.mimeType, 'application/vnd.apple.mpegurl')
  assert.equal(streams[1]?.quality, '1080p')
})

test('AnimesOnline seleciona um espelho válido quando outro devolve 403, usando apenas HEAD na mídia', async () => {
  await withFetch({
    [`GET ${BASE}/episodio/example-dub-episodio-01`]: episodePage(`<video><source src="${blocked}"><source src="${playable}"></video>`),
    [`HEAD ${blocked}`]: () => new Response(null, { status: 403 }),
    [`HEAD ${playable}`]: () => {
      const response = new Response('media must not be read', { headers: { 'content-type': 'video/mp4' } })
      Object.defineProperty(response.body, 'getReader', { value: () => assert.fail('não deve ler mídia') })
      return response
    },
  }, async (requests) => {
    const stream = await resolveAnimesOnline(`${BASE}/episodio/example-dub-episodio-01`)
    assert.equal(stream.url, playable)
    assert.equal(stream.mimeType, 'video/mp4')
    assert.equal(requests.filter((request) => request.method === 'GET').length, 1)
    assert.ok(requests.filter((request) => request.url !== `${BASE}/episodio/example-dub-episodio-01`).every((request) => request.method === 'HEAD'))
  })
})

test('AnimesOnline rejeita CDN com HTML, redirecionamento local e episódios sem links diretos sem trocar o áudio', async () => {
  const page = `${BASE}/episodio/example-dub-episodio-01`
  for (const response of [() => new Response(null, { headers: { 'content-type': 'text/html' } }),
    () => new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/private.mp4' } })]) {
    await withFetch({ [`GET ${page}`]: episodePage(`<video src="${playable}"></video>`), [`HEAD ${playable}`]: response }, async (requests) => {
      await assert.rejects(resolveAnimesOnline(page), /nenhum servidor/)
      assert.equal(requests.length, 2)
    })
  }
  await withFetch({ [`GET ${page}`]: episodePage('<iframe src="https://www.blogger.com/video.g?token=private"></iframe>') }, async (requests) => {
    await assert.rejects(resolveAnimesOnline(page), /sem URL HTTP direta/)
    assert.equal(requests.length, 1)
  })
})

test('AnimesOnline valida as referências e cancela respostas não HTML sem ler a mídia', async () => {
  for (const page of ['http://127.0.0.1/episodio/example', `${BASE}/anime/example`, 'https://user:pass@animesonline.cloud/episodio/example']) {
    await assert.rejects(resolveAnimesOnline(page), /Referência/)
  }
  const page = `${BASE}/episodio/example-episodio-01`
  await withFetch({ [`GET ${page}`]: () => new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/private' } }) }, async (requests) => {
    await assert.rejects(resolveAnimesOnline(page), /Redirecionamento/)
    assert.equal(requests.length, 1)
  })
  await withFetch({ [`GET ${page}`]: () => {
    const response = new Response('media must not be read', { headers: { 'content-type': 'video/mp4' } })
    Object.defineProperty(response.body, 'getReader', { value: () => assert.fail('não deve ler mídia') })
    return response
  } }, async () => { await assert.rejects(resolveAnimesOnline(page), /diferente de HTML/) })
})
