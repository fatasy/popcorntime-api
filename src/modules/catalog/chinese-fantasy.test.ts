import assert from 'node:assert/strict'
import { test } from 'node:test'
import { chineseFantasyFilterGenres, chineseFantasyGenres, isChineseAnimation, preserveChineseFantasyGenres } from './chinese-fantasy'

test('classifies provider xianxia and wuxia keywords for Chinese animation and dramas', () => {
  assert.deepEqual(chineseFantasyGenres({ origin_country: ['CN'], keywords: { results: [{ id: 234890 }] } }), ['Xianxia'])
  assert.deepEqual(chineseFantasyGenres({ original_language: 'zh', keywords: { results: [{ name: 'wuxia' }] } }), ['Wuxia'])
  assert.deepEqual(chineseFantasyGenres({ origin_country: ['CN'], keywords: { results: [{ id: 384653 }] } }), ['Xianxia', 'Wuxia'])
})

test('cultivation requires Chinese fantasy or animation, excluding agriculture', () => {
  assert.deepEqual(chineseFantasyGenres({ origin_country: ['CN'], genres: [{ id: 16 }], keywords: { results: [{ id: 377550 }] } }), ['Xianxia'])
  assert.deepEqual(chineseFantasyGenres({ origin_country: ['CN'], genres: [{ id: 99 }], keywords: { results: [{ name: 'cultivation' }] } }), [])
})

test('does not confuse all Chinese fantasy, martial arts, or Japanese anime with xianxia/wuxia', () => {
  assert.deepEqual(chineseFantasyGenres({ origin_country: ['CN'], genres: [{ id: 10765 }] }), [])
  assert.deepEqual(chineseFantasyGenres({ origin_country: ['CN'], keywords: { results: [{ name: 'martial arts' }] } }), [])
  assert.deepEqual(chineseFantasyGenres({ origin_country: ['JP'], genres: [{ id: 16 }], keywords: { results: [{ name: 'wuxia' }] } }), [])
})

test('donghua and live-action series have distinct media types', () => {
  assert.equal(isChineseAnimation({ original_language: 'zh', genre_ids: [16, 18] }), true)
  assert.equal(isChineseAnimation({ origin_country: ['CN'], genres: [{ id: 18 }] }), false)
  assert.equal(isChineseAnimation({ original_language: 'ja', genre_ids: [16] }), false)
})

test('combined genre filter matches either tag and narrow filters stay separate', () => {
  for (const label of ['Xianxia / Wuxia', 'xianxia-wuxia', 'xianxia_wuxia']) {
    assert.deepEqual(chineseFantasyFilterGenres(label), ['Xianxia', 'Wuxia'])
  }
  assert.deepEqual(chineseFantasyFilterGenres('xianxia'), ['Xianxia'])
  assert.deepEqual(chineseFantasyFilterGenres('Wuxia'), ['Wuxia'])
  assert.equal(chineseFantasyFilterGenres('Fantasia'), null)
})

test('metadata refresh retains confirmed tags without retaining outdated normal genres', () => {
  assert.deepEqual(preserveChineseFantasyGenres(['Drama', 'Xianxia'], ['Animação']), ['Animação', 'Xianxia'])
  assert.deepEqual(preserveChineseFantasyGenres(['Wuxia'], ['Wuxia', 'Ação']), ['Wuxia', 'Ação'])
  assert.equal(preserveChineseFantasyGenres(null, null), null)
})

test('TMDB mapper exposes Chinese category and donghua type without replacing the identity', async () => {
  process.env.DATABASE_URL ??= 'postgres://unused:unused@127.0.0.1:5432/unused'
  process.env.TMDB_API_KEY ??= 'unused'
  process.env.OMDb_API_KEY ??= 'unused'
  process.env.JWT_SECRET ??= 'chinese-fantasy-tests-only-key-0000'
  const { mapTmdb } = await import('../enrichment')
  const mapped = mapTmdb({ id: 223911, name: 'Renegade Immortal', origin_country: ['CN'],
    genres: [{ id: 16, name: 'Animação' }], keywords: { results: [{ id: 234890 }] } }, 'tv')
  assert.equal(mapped.type, 'anime')
  assert.equal(mapped.tmdb_id, 223911)
  assert.deepEqual(mapped.genres, ['Animação', 'Xianxia'])
})
