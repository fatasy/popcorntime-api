import assert from 'node:assert/strict'
import { test } from 'node:test'

process.env.DATABASE_URL ??= 'postgres://unused:unused@127.0.0.1:5432/unused'
process.env.TMDB_API_KEY ??= 'unused'
process.env.OMDb_API_KEY ??= 'unused'
process.env.JWT_SECRET ??= 'catalog-freshness-tests-only-key-0000'
const { fetchAnimeRanking } = await import('./trending')

test('anime fallback keeps TMDB identity, order and current-airing filters when Jikan fails', async () => {
  const original = globalThis.fetch
  const urls: URL[] = []
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
    const url = new URL(String(input)); urls.push(url)
    if (url.hostname === 'api.jikan.moe') return new Response('', { status: 503 })
    return Response.json({ total_pages: 1, results: [
      { id: 2, name: 'Second identity, first rank', first_air_date: '2026-10-01' },
      { id: 1, name: 'First identity, second rank', first_air_date: '2025-01-01' },
    ] })
  }) as unknown as typeof fetch
  try {
    const items = await fetchAnimeRanking()
    assert.deepEqual(items.map((item) => [item.type, item.source, item.tmdb_id, item.mal_id]),
      [['anime', 'tmdb', 2, null], ['anime', 'tmdb', 1, null]])
    const fallback = urls[1]!
    assert.equal(fallback.searchParams.get('with_genres'), '16')
    assert.equal(fallback.searchParams.get('with_original_language'), 'ja')
    assert.equal(fallback.searchParams.get('sort_by'), 'popularity.desc')
    assert.match(fallback.searchParams.get('air_date.gte')!, /^\d{4}-\d{2}-\d{2}$/)
    assert.equal(fallback.searchParams.get('air_date.lte'), new Date().toISOString().slice(0, 10))
  } finally { globalThis.fetch = original }
})

test('healthy MAL ranking remains in provider order without calling fallback', async () => {
  const original = globalThis.fetch
  let calls = 0
  globalThis.fetch = (async () => {
    calls++
    return Response.json({ data: [{ mal_id: 7, title: 'First' }, { mal_id: 3, title: 'Second' }, { mal_id: 7 }] })
  }) as unknown as typeof fetch
  try {
    assert.deepEqual((await fetchAnimeRanking()).map((item) => [item.source, item.mal_id]), [['jikan', 7], ['jikan', 3]])
    assert.equal(calls, 1)
  } finally { globalThis.fetch = original }
})
