import { test } from 'node:test'
import assert from 'node:assert/strict'
import { extractQuality, extractQualityLabel } from './quality'

test('recognizes resolution labels joined to codec tags and bare resolution numbers', () => {
  for (const [title, resolution] of [
    ['Release.2160pHEVC', '2160p'], ['Release.1080pHEVC', '1080p'],
    ['Release [1080]', '1080p'], ['Release.720pHEVC', '720p'],
    ['Release [720]', '720p'], ['Release [480]', '480p'],
  ]) {
    assert.equal(extractQualityLabel(title!), resolution)
  }
  assert.equal(extractQualityLabel('Release without quality tags'), 'Unknown')
})

test('preserves the source and codec when extracting full quality information', () => {
  assert.deepEqual(extractQuality('Release.1080pHEVC.WEB-DL.x265'), {
    resolution: '1080p', source: 'WEB-DL', codec: 'x265',
  })
})
