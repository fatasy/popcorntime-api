import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { ProviderEpisode } from './episode-providers'
import type { EpisodeInfo } from './episodes'
import type { EpisodeMetadata } from './episode-types'
import { mergeHttpEpisodeSources } from '../streams/episodes'

// These checks only exercise in-memory mapping and never connect to a database.
process.env.DATABASE_URL ??= 'postgres://unused:unused@127.0.0.1:5432/unused'
process.env.TMDB_API_KEY ??= 'unused'
process.env.OMDb_API_KEY ??= 'unused'
process.env.JWT_SECRET ??= 'episode-metadata-tests-only-key-0000'

const { attachEpisodeMetadata } = await import('./episode-metadata')
const { buildListingIndex, mapProviderEpisodes } = await import('./episode-providers')

function metadata(overrides: Partial<EpisodeMetadata> = {}): EpisodeMetadata {
  return {
    season: 1, episode: 1, source: 'tvmaze', source_episode_id: '11',
    title: 'Provider title', title_original: null, overview: 'Episode overview',
    air_date: '2026-09-22', runtime_sec: 1440, score: null, filler: false, recap: false,
    still_path: null, still_url: 'https://images.example/episode.jpg',
    thumbnail_url: 'https://images.example/episode.jpg', image_source: 'tvmaze',
    image_kind: 'still', image_match: 'imdb', image_credit: 'TVmaze',
    image_credit_url: 'https://www.tvmaze.com', image_license: 'CC BY-SA 4.0',
    ...overrides,
  }
}

function provider(episode: number): ProviderEpisode {
  return {
    season: 1, episode, source: 'jikan', source_episode_id: String(episode),
    title: `Episode ${episode}`, title_original: null, overview: null, air_date: null,
    runtime_sec: null, score: null, filler: false, recap: false,
    still_path: null, still_url: null, image_source: null, image_match: null,
  }
}

test('maps absolute anime episodes across contiguous seasons without duplicating targets', () => {
  const index = buildListingIndex([
    { key: '1|1', season: 1, episode: 1 }, { key: '1|2', season: 1, episode: 2 },
    { key: '2|1', season: 2, episode: 1 }, { key: '2|2', season: 2, episode: 2 },
  ])
  const mapped = mapProviderEpisodes([provider(3), provider(3), provider(4), provider(0)], index, 'anime')
  assert.deepEqual(mapped.map((episode) => [episode.season, episode.episode]), [[2, 1], [2, 2]])
})

test('does not reinterpret series or sparse anime seasons as absolute numbering', () => {
  const contiguous = buildListingIndex([
    { key: '1|1', season: 1, episode: 1 }, { key: '2|1', season: 2, episode: 1 },
  ])
  assert.deepEqual(mapProviderEpisodes([provider(2)], contiguous, 'series'), [])
  const sparse = buildListingIndex([{ key: '5|1', season: 5, episode: 1 }])
  assert.deepEqual(mapProviderEpisodes([provider(1)], sparse, 'anime'), [])
})

test('attaches episode artwork and attribution while preserving HTTP streams and torrent sources', () => {
  const torrent = {
    hash: 'example', magnet_link: 'magnet:?xt=urn:btih:example', title: 'Dubbed release',
    seeds: 5, file_index: 0, inferred: false, quality: '1080p', size_bytes: 100,
    collected_at: null, ptbr_audio: true,
  }
  const episodes: EpisodeInfo[] = [
    { season: 1, episode: 1, title: 'Existing title', air_date: '2026-09-21', torrents: [torrent] },
  ]
  const merged = mergeHttpEpisodeSources(episodes, [{
    id: 9, content_id: 1, season: 1, episode: 1, provider: 'animesonline',
    page_url: 'https://animesonline.cloud/episodio/example', title: 'Example dubbed',
    audio_type: 'dubbed', stream_url: null, quality: null, resolved_at: null,
    collected_at: new Date('2026-09-22T00:00:00Z'),
  }])
  attachEpisodeMetadata(merged, new Map([['1|1', metadata()]]))
  assert.equal(merged[0]?.title, 'Existing title')
  assert.equal(merged[0]?.air_date, '2026-09-21')
  assert.deepEqual(merged[0]?.torrents, [torrent])
  assert.equal(merged[0]?.streams?.[0]?.id, 9)
  assert.equal(merged[0]?.streams?.[0]?.audio_type, 'dubbed')
  assert.equal(merged[0]?.image_kind, 'still')
  assert.equal(merged[0]?.image_source, 'tvmaze')
  assert.equal(merged[0]?.image_credit_url, 'https://www.tvmaze.com')
  assert.equal(merged[0]?.thumbnail_url, 'https://images.example/episode.jpg')
})

test('labels older cached content artwork as fallback and missing artwork as none', () => {
  for (const [thumbnail, expected] of [['https://images.example/backdrop.jpg', 'fallback'], [null, 'none']] as const) {
    const episodes: EpisodeInfo[] = [{ season: 1, episode: 1, title: null, air_date: null, torrents: [] }]
    attachEpisodeMetadata(episodes, new Map([['1|1', metadata({
      source: 'none', still_url: null, thumbnail_url: thumbnail, image_kind: null,
      image_source: null, image_match: null, image_credit: null,
      image_credit_url: null, image_license: null,
    })]]))
    assert.equal(episodes[0]?.image_kind, expected)
    assert.equal(episodes[0]?.still_url, null)
    assert.equal(episodes[0]?.metadata_source, null)
  }
})
