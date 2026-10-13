import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DORAMA_COUNTRIES, doramaGenres, isDoramaFilter, preserveDoramaGenres } from './dorama'

test('Asian scripted TV and miniseries are doramas across all supported origins', () => {
  for (const country of DORAMA_COUNTRIES) {
    assert.deepEqual(doramaGenres({ origin_country: [country], type: 'Scripted', genres: [{ id: 18 }] }), ['Dorama'])
    assert.deepEqual(doramaGenres({ origin_country: [country], type: 'Miniseries', genres: [{ id: 80 }] }), ['Dorama'])
  }
})

test('films, anime, donghua, reality, news and talk shows are excluded', () => {
  assert.deepEqual(doramaGenres({ origin_country: ['KR'], type: 'Scripted', genres: [{ id: 18 }] }, 'movie'), [])
  for (const id of [16, 99, 10763, 10764, 10767]) {
    assert.deepEqual(doramaGenres({ origin_country: ['JP'], type: 'Scripted', genres: [{ id }, { id: 18 }] }), [])
  }
  for (const type of ['Reality', 'Talk Show', 'Documentary', 'News']) {
    assert.deepEqual(doramaGenres({ origin_country: ['KR'], type, genres: [{ id: 35 }] }), [])
  }
  assert.deepEqual(doramaGenres({ origin_country: ['US'], original_language: 'ja', type: 'Scripted', genre_ids: [18] }), [])
})

test('older metadata requires drama/comedy and a supported production origin', () => {
  assert.deepEqual(doramaGenres({ production_countries: [{ iso_3166_1: 'KR' }], genre_ids: [18] }), ['Dorama'])
  assert.deepEqual(doramaGenres({ original_language: 'ja', genre_ids: [35] }), ['Dorama'])
  assert.deepEqual(doramaGenres({ origin_country: ['KR'], genre_ids: [10759] }), [])
})

test('filter aliases and metadata refresh preserve the category without preserving old normal genres', () => {
  for (const value of ['Dorama', 'doramas', ' DORAMA ']) assert.equal(isDoramaFilter(value), true)
  assert.equal(isDoramaFilter('Drama'), false)
  assert.deepEqual(preserveDoramaGenres(['Dorama', 'Drama'], ['Comédia']), ['Comédia', 'Dorama'])
  assert.equal(preserveDoramaGenres(null, null), null)
})

test('TMDB TV mapping adds the category, while movies keep their normal genres', async () => {
  process.env.DATABASE_URL ??= 'postgres://unused:unused@127.0.0.1:5432/unused'
  process.env.TMDB_API_KEY ??= 'unused'
  process.env.OMDb_API_KEY ??= 'unused'
  process.env.JWT_SECRET ??= 'dorama-tests-only-key-0000000000000'
  const { mapTmdb } = await import('../enrichment')
  const tv = { id: 93405, name: 'Round 6', type: 'Scripted', origin_country: ['KR'], genres: [{ id: 18, name: 'Drama' }] }
  assert.deepEqual(mapTmdb(tv, 'tv').genres, ['Drama', 'Dorama'])
  assert.deepEqual(mapTmdb(tv, 'movie').genres, ['Drama'])
})
