import assert from 'node:assert/strict'
import { test } from 'node:test'
import { resolveTmdbIdentity } from './identity'

test('preserves discovered IDs without searching a translated movie title', async () => {
  const item = await resolveTmdbIdentity({ type: 'movie', tmdb_id: 42, year: 2026 }, 'Guerra', async () => {
    throw new Error('search would select another movie')
  })
  assert.deepEqual(item, { id: 42, media_type: 'movie' })
})

test('anime TMDB IDs use the TV namespace', async () => {
  assert.deepEqual(await resolveTmdbIdentity({ type: 'anime', tmdb_id: 42, year: null }, 'Anime', async () => []),
    { id: 42, media_type: 'tv' })
})

test('a same-year movie cannot replace a series search match', async () => {
  const item = await resolveTmdbIdentity({ type: 'series', tmdb_id: null, year: 2026 }, 'Guerra', async () => [
    { id: 1, media_type: 'movie', release_date: '2026-10-01' },
    { id: 2, media_type: 'tv', first_air_date: '2025-10-01' },
    { id: 3, media_type: 'tv', first_air_date: '2026-10-01' },
  ])
  assert.deepEqual(item, { id: 3, media_type: 'tv' })
})

test('does not switch media type when the requested kind has no match', async () => {
  assert.equal(await resolveTmdbIdentity({ type: 'movie', tmdb_id: null, year: null }, 'Title', async () => [
    { id: 1, media_type: 'tv' },
  ]), null)
})
