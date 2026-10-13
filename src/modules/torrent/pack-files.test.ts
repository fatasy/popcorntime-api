import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseRelease } from '../../lib/parse'
import { indexedPackEpisodes } from './pack-files'

const options = {
  linkedSeason: 1, singleSeasonAnime: true,
  isEpisodeFile: (name: string) => /\.mkv$/i.test(name),
  episodeNumber: (name: string) => (parseRelease(name).episode ?? Number(/ - (\d+)/.exec(name)?.[1])) || null,
}

test('pack text files and unordered video names preserve their original torrent indexes', () => {
  const result = indexedPackEpisodes([
    { index: 0, name: 'readme.txt' },
    { index: 1, name: 'Show.S01E006.mkv' },
    { index: 2, name: 'Show.S01E002.mkv' },
    { index: 3, name: 'Show.S01E001.mkv' },
  ], options)
  assert.deepEqual(result, [
    { season: 1, episode: 6, fileIndex: 1 },
    { season: 1, episode: 2, fileIndex: 2 },
    { season: 1, episode: 1, fileIndex: 3 },
  ])
  assert.equal(result?.some((item) => item.episode === 169), false)
})

test('continuous donghua episode numbers flatten part labels without inventing offsets', () => {
  assert.deepEqual(indexedPackEpisodes([
    { index: 13, name: 'Show.S01E013.mkv' },
    { index: 14, name: 'Show.S02E014.mkv' },
    { index: 59, name: 'Show.S02E059.mkv' },
  ], options), [
    { season: 1, episode: 13, fileIndex: 13 },
    { season: 1, episode: 14, fileIndex: 14 },
    { season: 1, episode: 59, fileIndex: 59 },
  ])
})

test('series with real seasons and anime that restart numbering retain distinct season keys', () => {
  const files = [{ index: 0, name: 'Show.S01E001.mkv' }, { index: 1, name: 'Show.S02E001.mkv' }]
  const expected = [{ season: 1, episode: 1, fileIndex: 0 }, { season: 2, episode: 1, fileIndex: 1 }]
  assert.deepEqual(indexedPackEpisodes(files, options), expected)
  assert.deepEqual(indexedPackEpisodes(files, { ...options, singleSeasonAnime: false }), expected)
})

test('missing metainfo retains the existing resolution path', () => {
  assert.equal(indexedPackEpisodes(null, options), null)
  assert.equal(indexedPackEpisodes([], options), null)
})
