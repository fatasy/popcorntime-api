import assert from 'node:assert/strict'
import { test } from 'node:test'
import { animeSourceQueries, animeTorrentMatchesTitle, animeTorrentQueries,
  expandAnimeTitleAliases, providerAnimeAliases } from './title-aliases'
import { parseAnimeSearch } from './animesdigital'

const composite = 'My Senior Brother Is Too Steady [Shixiong A Shixiong]'
const alternatives = ['Shi Xiong A Shi Xiong', 'Big Brother', 'Senior Brother', 'My Senior Brother is Too']
const titles = expandAnimeTitleAliases([composite, '师兄啊师兄', ...alternatives])

test('a composite catalog label yields separate exact search names', () => {
  assert.deepEqual(expandAnimeTitleAliases([composite]).slice(0, 2),
    ['My Senior Brother Is Too Steady', 'Shixiong A Shixiong'])
  assert.equal(animeSourceQueries(titles)[0], 'My Senior Brother Is Too Steady')
  assert.equal(animeSourceQueries(titles).includes(composite), false)
})

test('parenthesized alternative titles work without stripping season or movie qualifiers', () => {
  assert.deepEqual(expandAnimeTitleAliases(['Soul Land (Douluo Dalu)']).slice(0, 2), ['Soul Land', 'Douluo Dalu'])
  for (const title of ['Attack on Titan (Final Season)', 'Example (TV)', 'Example (Movie)', 'Example (Season 2)']) {
    assert.deepEqual(expandAnimeTitleAliases([title]), [title])
  }
})

test('source material names are not aliases of the anime adaptation', () => {
  assert.deepEqual(providerAnimeAliases({ results: [
    { title: 'Shixiong A Shixiong', type: '' },
    { title: 'Wo Shixiong Shizai Tai Wenjianle', type: 'source material' },
  ] }), ['Shixiong A Shixiong'])
})

test('exact HTTP provider results match the split alias but not the similarly named anime', () => {
  const html = '<a href="/anime/steady/">My Senior Brother Is Too Steady</a>' +
    '<a href="/anime/strong/">My Senior Brother Is Too Strong</a>'
  assert.deepEqual(parseAnimeSearch(html, titles).map((hit) => hit.title), ['My Senior Brother Is Too Steady'])
})

test('torrent matching accepts the real multi-season and first-season batch names', () => {
  assert.equal(animeTorrentMatchesTitle('My.Senior.Brother.Is.Too.Steady.(Shi.Xiong.A.Shi.Xiong).1080p.S01E001-S02E059.Chinese Donghua', titles), true)
  assert.equal(animeTorrentMatchesTitle('[SanKyuu] 师兄啊师兄 | Shi Xiong A Shi Xiong | My Senior Brother is Too Steady S1 (01-13 Fin) [1080p] [Batch]', titles), true)
})

test('fuzzy search results and abbreviated provider aliases cannot relink unrelated shows', () => {
  assert.equal(animeTorrentMatchesTitle('[ToonsHub] My Senior Brother is Too Strong S01E01 1080p (Wo De Shixiong Tai Qiang Le)', titles), false)
  assert.equal(animeTorrentMatchesTitle('My Senior Brother Has a Pit in His Brain (Wo Jia Da Shixiong Naozi You Keng) Ep 01-26', titles), false)
  assert.equal(animeTorrentMatchesTitle('Big Brother S01E01 1080p', titles), false)
  assert.equal(animeTorrentQueries(titles).includes('Big Brother'), false)
})

test('standard fansub separators and title punctuation remain valid', () => {
  assert.equal(animeTorrentMatchesTitle('[SubsPlease] Example - 01 (1080p)', ['Example']), true)
  assert.equal(animeTorrentMatchesTitle('[Group] Re:Zero - S01E01 [1080p]', ['Re:Zero']), true)
  assert.equal(animeTorrentMatchesTitle('[Group] Example2 - 01 [1080p]', ['Example']), false)
  assert.equal(animeTorrentMatchesTitle('[Group] Example 2 - 01 [1080p]', ['Example']), false)
  assert.equal(animeTorrentMatchesTitle('[Group] Xian Ni - 01 [1080p]', ['Renegade Immortal', 'Xian Ni']), true)
})
