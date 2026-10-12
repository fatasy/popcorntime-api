import { test } from 'node:test'
import assert from 'node:assert/strict'
import { BackgroundRefreshQueue, readExternalCatalog } from './background-refresh'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((ok, fail) => { resolve = ok; reject = fail })
  return { promise, resolve, reject }
}

test('serves an expired catalog without awaiting a stalled provider', async () => {
  const provider = deferred<string[]>()
  const queue = new BackgroundRefreshQueue()
  const result = await readExternalCatalog({ key: 'anime:1', queue, ttlMs: 1,
    read: async () => ({ value: ['Saved episode title'], cachedAt: new Date(0) }),
    refresh: () => provider.promise })
  assert.deepEqual(result, ['Saved episode title'])
  provider.resolve(['Updated title'])
  await queue.run('anime:1', () => { throw new Error('duplicate provider request') })
})

test('a missing anime catalog returns immediately while the provider warms the cache', async () => {
  const provider = deferred<string[]>()
  const queue = new BackgroundRefreshQueue()
  assert.equal(await readExternalCatalog({ key: 'anime:2', queue, ttlMs: 1,
    read: async () => null, refresh: () => provider.promise }), null)
  provider.resolve(['Episode 1'])
  assert.deepEqual(await queue.run('anime:2', () => { throw new Error('duplicate request') }), ['Episode 1'])
})

test('limits the first uncached TV lookup wait and keeps its refresh alive', async () => {
  const provider = deferred<string[]>()
  const queue = new BackgroundRefreshQueue()
  assert.equal(await readExternalCatalog({ key: 'tv:3', queue, ttlMs: 1, coldWaitMs: 5,
    read: async () => null, refresh: () => provider.promise }), null)
  provider.resolve(['Season 1'])
  assert.deepEqual(await queue.run('tv:3', () => { throw new Error('duplicate request') }), ['Season 1'])
})

test('coalesces refreshes and bounds concurrency across different titles', async () => {
  const queue = new BackgroundRefreshQueue(1)
  const first = deferred<string>()
  let secondStarted = false
  const one = queue.run('one', () => first.promise)
  assert.equal(queue.run('one', async () => 'duplicate'), one)
  const two = queue.run('two', async () => { secondStarted = true; return 'two' })
  await Promise.resolve()
  assert.equal(secondStarted, false)
  first.resolve('one')
  assert.deepEqual(await Promise.all([one, two]), ['one', 'two'])
  assert.equal(secondStarted, true)
})

test('does not repeatedly retry an unavailable provider during its cooldown', async () => {
  const failures: unknown[] = []
  const queue = new BackgroundRefreshQueue(1, 60_000, (_key, error) => failures.push(error))
  const job = queue.schedule('offline', async () => { throw new Error('offline') })!
  await assert.rejects(job, /offline/)
  assert.equal(queue.schedule('offline', async () => 'unexpected retry'), null)
  assert.equal(failures.length, 1)
})

test('explicit refresh bypasses a fresh cache and retains saved data on provider failure', async () => {
  const queue = new BackgroundRefreshQueue()
  const read = async () => ({ value: 'saved', cachedAt: new Date() })
  assert.equal(await readExternalCatalog({ key: 'manual', queue, ttlMs: 60_000,
    read, refresh: async () => 'updated', force: true }), 'updated')
  assert.equal(await readExternalCatalog({ key: 'manual', queue, ttlMs: 60_000,
    read, refresh: async () => { throw new Error('provider offline') }, force: true }), 'saved')
})
