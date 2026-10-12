import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ANIMEFIRE_API, discoverAnimeFire, extractAnimeFireStream, parseAnimeFireEpisodes,
  parseAnimeFireSearch, resolveAnimeFire } from './animefire'
import { animeHttpProviders, discoverAnimeHttpSources, httpProviderMetadata } from './providers'

const BASE = ANIMEFIRE_API
const search = { data: [
  { id: 'show', titles: { BR: 'Example', JP: 'Exemplo' } },
  { id: 'sequel', titles: { BR: 'Example 2' } },
  { id: 'movie', titles: { BR: 'Example: The Movie' } },
] }
const episode = (id: string, number: number, season = 1, audio = 'Dublado & Legendado') =>
  ({ id, number, season, audio, title: null })
const detail = { data: { hero: { id: 'show', titles: { BR: 'Example' } },
  seasons: [{ number: 1, first_episode_number: 1 }, { number: 2, first_episode_number: 26 }],
  episodes: [episode('first', 1), episode('part-two', 13), episode('last', 25),
    episode('next-season', 1, 2), episode('special', 12.5), episode('unknown-audio', 2, 1, 'Desconhecido')],
} }
const streamJson = { data: { streams: [
  { audio: 'legendado', is_offline: false, url: 'https://akumast.net/i/fresh-sub/h.jpg' },
  { audio: 'dublado', is_offline: false, url: 'https://akumast.net/i/fresh-dub/h.jpg' },
] } }

async function withJson(pages: Record<string, unknown | Response>, run: (requests: string[]) => Promise<void>) {
  const original = globalThis.fetch
  const requests: string[] = []
  globalThis.fetch = Object.assign(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    requests.push(url)
    assert.equal(init?.redirect, 'error', 'não seguir redirecionamentos para outros servidores')
    const page = pages[url]
    assert.ok(page, `unexpected fetch: ${url}`)
    return page instanceof Response ? page : Response.json(page)
  }, { preconnect: original.preconnect }) as typeof fetch
  try { await run(requests) } finally { globalThis.fetch = original }
}

test('AnimeFire seleciona aliases exatos sem confundir sequelas e filmes', () => {
  assert.deepEqual(parseAnimeFireSearch(search, ['Éxample']).map((hit) => hit.id), ['show'])
  assert.deepEqual(parseAnimeFireSearch(search, ['Exemplo']).map((hit) => hit.id), ['show'])
})

test('duas versões na mesma página têm identidades distintas; especiais não entram', () => {
  const episodes = parseAnimeFireEpisodes(detail, { titles: ['Example'], targetEpisode: 1 })
  assert.deepEqual(episodes.map((ep) => ep.audioType).sort(), ['dubbed', 'subbed'])
  assert.equal(new Set(episodes.map((ep) => ep.pageUrl)).size, 2)
  assert.ok(episodes.every((ep) => ep.episode === 1 && ep.provider === 'animefire'))
  assert.ok(!parseAnimeFireEpisodes(detail, { titles: ['Example'] }).some((ep) => ep.episode === 12.5 || ep.episode === 2))
})

test('parte 2 usa offset e limita episódios à parte sem repetir a parte 1', () => {
  const episodes = parseAnimeFireEpisodes(detail, { titles: ['Example Part 2'], seriesTitles: ['Example'],
    season: 1, episodeOffset: 12, episodeCount: 13, targetEpisode: 1 })
  assert.equal(episodes.length, 2)
  assert.ok(episodes.every((ep) => ep.episode === 1 && ep.pageUrl.includes('part-two')))
})

test('temporada 2 mantém o número local mesmo com first_episode_number absoluto', () => {
  const episodes = parseAnimeFireEpisodes(detail, { titles: ['Example 2nd Season'], seriesTitles: ['Example'],
    season: 2, episodeCount: 12, targetEpisode: 1 })
  assert.equal(episodes.length, 2)
  assert.ok(episodes.every((ep) => ep.pageUrl.includes('next-season') && ep.episode === 1))
  assert.deepEqual(parseAnimeFireEpisodes(detail, { titles: ['Example Season 3'], seriesTitles: ['Example'], season: 3 }), [])
})

test('edição dedicada usa seus episódios locais ao casar o título específico do MAL', () => {
  const dedicated = { data: { hero: { id: 'sequel', titles: { BR: 'Example 2nd Season' } },
    seasons: [{ number: 1 }], episodes: [episode('dedicated', 1)] } }
  const episodes = parseAnimeFireEpisodes(dedicated, { titles: ['Example Season 2'], seriesTitles: ['Example'], season: 2 })
  assert.equal(episodes.length, 2)
  assert.deepEqual(parseAnimeFireEpisodes(dedicated, { titles: ['Other'], seriesTitles: ['Other'] }), [])
})

test('descoberta consulta apenas busca e catálogo JSON, sem resolver todos os vídeos', async () => {
  await withJson({ [`${BASE}/animes/pesquisar?q=Example&v=3`]: search, [`${BASE}/anime/show?v=3`]: detail }, async (requests) => {
    const episodes = await discoverAnimeFire({ titles: ['Example'], targetEpisode: 1 })
    assert.equal(episodes.length, 2)
    assert.equal(requests.length, 2)
    assert.ok(requests.every((url) => !url.includes('/episode/')))
  })
})

test('resolução renova a versão escolhida sem abrir o HLS com extensão jpg', async () => {
  await withJson({ [`${BASE}/episode/first?v=3`]: streamJson }, async (requests) => {
    const stream = await resolveAnimeFire(`${BASE}/episode/first?v=3#audio=dubbed`)
    assert.deepEqual(stream, { url: 'https://akumast.net/i/fresh-dub/h.jpg', quality: null,
      mimeType: 'application/vnd.apple.mpegurl' })
    assert.equal(requests.length, 1)
  })
})

test('não troca áudio quando a versão escolhida está offline, nem aceita imagens ou URLs locais', () => {
  const unavailable = { data: { streams: [
    { ...streamJson.data.streams[1], is_offline: true }, streamJson.data.streams[0],
    { audio: 'dublado', is_offline: false, url: 'https://cdn.example.com/poster.jpg' },
    { audio: 'dublado', is_offline: false, url: 'http://192.168.1.1/episode.m3u8' },
  ] } }
  assert.equal(extractAnimeFireStream(unavailable, 'dubbed'), null)
  assert.equal(extractAnimeFireStream(unavailable, 'subbed')?.url, streamJson.data.streams[0]!.url)
})

test('referências fora da API ou sem áudio são recusadas antes de qualquer requisição', async () => {
  await withJson({}, async (requests) => {
    for (const url of ['http://127.0.0.1/episode/first#audio=dubbed', 'https://evil.example/episode/first#audio=dubbed',
      `${BASE}/episode/first?v=3`, `${BASE}/anime/show#audio=dubbed`]) {
      await assert.rejects(resolveAnimeFire(url), /Referência/)
    }
    assert.equal(requests.length, 0)
  })
})

test('recusa erros HTTP e mídia em lugar de JSON sem ler o corpo de vídeo', async () => {
  const url = `${BASE}/episode/first?v=3`
  await withJson({ [url]: new Response('', { status: 429 }) }, async () => {
    await assert.rejects(resolveAnimeFire(`${url}#audio=subbed`), /HTTP 429/)
  })
  const media = new Response('video bytes', { headers: { 'content-type': 'video/mp4' } })
  Object.defineProperty(media.body, 'getReader', { value: () => assert.fail('não deve ler mídia') })
  await withJson({ [url]: media }, async () => {
    await assert.rejects(resolveAnimeFire(`${url}#audio=subbed`), /diferente de JSON/)
    assert.equal(media.bodyUsed, true)
  })
})

test('ambos os provedores são publicados e a falha de um preserva as fontes do outro', async () => {
  assert.deepEqual(httpProviderMetadata().map((provider) => provider.id), ['animesdigital', 'animefire'])
  const episodes = parseAnimeFireEpisodes(detail, { titles: ['Example'], targetEpisode: 1 })
  const result = await discoverAnimeHttpSources({ titles: ['Example'] }, undefined, [
    { ...animeHttpProviders[0]!, discover: async () => { throw new Error('HTTP 503') } },
    { ...animeHttpProviders[1]!, discover: async () => episodes },
  ])
  assert.deepEqual(result.episodes, episodes)
  assert.deepEqual(result.sourceWarnings, ['AnimesDigital (Example): HTTP 503'])
})
