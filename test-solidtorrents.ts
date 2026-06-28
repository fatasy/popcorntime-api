// Quick verification test for rate limiting + caching
import { searchSolidTorrents } from './src/modules/collection/sources/solidtorrents'

const query = 'Breaking Bad S01E01'

console.time('call1')
const r1 = await searchSolidTorrents(query, 5)
console.timeEnd('call1')
console.log(`Call 1: ${r1.length} results`)

// Second call immediately after — should hit cache (or wait for rate limiter)
console.time('call2')
const r2 = await searchSolidTorrents(query, 5)
console.timeEnd('call2')
console.log(`Call 2: ${r2.length} results (should be cache hit, near-instant)`)

// Third call with different query — should be delayed by rate limiter
console.time('call3')
const r3 = await searchSolidTorrents('Better Call Saul S01E01', 5)
console.timeEnd('call3')
console.log(`Call 3: ${r3.length} results`)

console.log('\n--- All calls completed ---')
console.log('If call2 was fast: caching works.')
console.log('If calls were spaced ~2s apart: rate limiting works.')
