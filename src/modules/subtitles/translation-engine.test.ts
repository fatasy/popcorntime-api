import { expect, test } from 'bun:test'
import { createSubtitleTranslator } from './translation-engine'

interface Cue { id: number; text: string }
interface RequestBody {
  reasoning_effort?: string
  messages: Array<{ role: string; content: string }>
}

const input = { apiKey: 'test-key', sessionId: 'test-session', targetLanguage: 'pt-BR', sourceLanguage: 'en' }

function timestamp(seconds: number): string {
  return [Math.floor(seconds / 3600), Math.floor(seconds / 60) % 60, seconds % 60]
    .map((part) => String(part).padStart(2, '0')).join(':') + '.000'
}

function sourceVtt(count: number, text = (id: number) => `Hello ${id}`): string {
  return 'WEBVTT\n\n' + Array.from({ length: count }, (_, index) =>
    `cue-${index + 1}\n${timestamp(index * 2)} --> ${timestamp(index * 2 + 1)} align:start\n${text(index + 1)}`,
  ).join('\n\n') + '\n'
}

function readRequest(init: RequestInit) {
  const body = JSON.parse(String(init.body)) as RequestBody
  const payload = JSON.parse(body.messages[1]!.content) as {
    cues: Cue[]
    context: { before: Cue[]; after: Cue[]; originalCues?: Cue[] }
  }
  return { body, ...payload }
}

function translatedResponse(cues: Cue[]): Response {
  return Response.json({ choices: [{ message: {
    content: JSON.stringify({ translations: cues.map((cue) => ({ id: cue.id, text: `Olá ${cue.id}` })) }),
  } }] })
}

test('runs bounded parallel batches and preserves cue order, timings, metadata and progress', async () => {
  const source = sourceVtt(10).replace('WEBVTT\n\n', 'WEBVTT\nKind: captions\n\nNOTE source --> keep\n\nSTYLE\n::cue { color: white; }\n\n')
  let active = 0
  let peak = 0
  const requests: ReturnType<typeof readRequest>[] = []
  const progress: number[] = []
  const completedBatches: number[] = []
  const translate = createSubtitleTranslator({
    model: 'deepseek-v4-flash', concurrency: 3, maxChunkCues: 2,
    fetch: async (_, init) => {
      const request = readRequest(init)
      requests.push(request)
      active++
      peak = Math.max(peak, active)
      await Bun.sleep(request.cues[0]!.id === 1 ? 30 : 2)
      active--
      completedBatches.push(request.cues[0]!.id)
      return translatedResponse([...request.cues].reverse())
    },
  })
  const output = await translate(source, { ...input, onProgress: (completed) => progress.push(completed) })
  expect(peak).toBe(3)
  expect(completedBatches[0]).not.toBe(1)
  expect(output).toBe(source.replace(/Hello (\d+)/g, 'Olá $1'))
  expect(progress).toEqual([...progress].sort((a, b) => a - b))
  expect(progress.at(-1)).toBe(10)
  expect(requests.find((request) => request.cues[0]!.id === 3)!.context).toEqual({
    before: [{ id: 1, text: 'Hello 1' }, { id: 2, text: 'Hello 2' }],
    after: [{ id: 5, text: 'Hello 5' }, { id: 6, text: 'Hello 6' }],
  })
})

test('uses 72-cue batches and disables DeepSeek reasoning through OpenCode Go', async () => {
  const requests: ReturnType<typeof readRequest>[] = []
  const translate = createSubtitleTranslator({ model: 'deepseek-v4-flash', fetch: async (_, init) => {
    const request = readRequest(init)
    requests.push(request)
    expect(new Headers(init.headers).get('x-opencode-session')).toBe(input.sessionId)
    return translatedResponse(request.cues)
  } })
  await translate(sourceVtt(200), input)
  expect(requests.map((request) => request.cues.length)).toEqual([72, 72, 56])
  expect(requests.every((request) => request.body.reasoning_effort === 'none')).toBe(true)
})

test('does not send DeepSeek-specific reasoning options to other models', async () => {
  const translate = createSubtitleTranslator({ model: 'another-model', fetch: async (_, init) => {
    const request = readRequest(init)
    expect(request.body.reasoning_effort).toBeUndefined()
    return translatedResponse(request.cues)
  } })
  await translate(sourceVtt(1), input)
})

test('limits batch size by characters as well as cue count', async () => {
  const sizes: number[] = []
  const translate = createSubtitleTranslator({ model: 'deepseek-v4-flash', maxChunkChars: 1000,
    fetch: async (_, init) => {
      const request = readRequest(init)
      sizes.push(request.cues.length)
      expect(request.cues.reduce((sum, cue) => sum + cue.text.length + 32, 0)).toBeLessThanOrEqual(1000)
      return translatedResponse(request.cues)
    },
  })
  await translate(sourceVtt(5, () => 'x'.repeat(400)), input)
  expect(sizes).toEqual([2, 2, 1])
})

test('shares the concurrency limit across simultaneous jobs', async () => {
  let active = 0
  let peak = 0
  const translate = createSubtitleTranslator({ model: 'deepseek-v4-flash', concurrency: 4, maxChunkCues: 2,
    fetch: async (_, init) => {
      active++
      peak = Math.max(peak, active)
      await Bun.sleep(2)
      active--
      return translatedResponse(readRequest(init).cues)
    },
  })
  const results = await Promise.all([
    translate(sourceVtt(20), { ...input, sessionId: 'first' }),
    translate(sourceVtt(20), { ...input, sessionId: 'second' }),
  ])
  expect(peak).toBe(4)
  expect(active).toBe(0)
  expect(results.every((result) => result.includes('Olá 20'))).toBe(true)
})

test('retries only missing cues and retains translations already received', async () => {
  const requests: ReturnType<typeof readRequest>[] = []
  const translate = createSubtitleTranslator({ model: 'deepseek-v4-flash', retryDelayMs: 0,
    fetch: async (_, init) => {
      const request = readRequest(init)
      const cues = request.cues
      requests.push(request)
      return translatedResponse(requests.length === 1 ? cues.slice(0, 2) : cues)
    },
  })
  const output = await translate(sourceVtt(3), input)
  expect(requests.map((request) => request.cues.map((cue) => cue.id))).toEqual([[1, 2, 3], [3]])
  expect(requests[1]!.context.originalCues).toEqual([
    { id: 1, text: 'Hello 1' }, { id: 2, text: 'Hello 2' }, { id: 3, text: 'Hello 3' },
  ])
  expect(output).toBe(sourceVtt(3).replace(/Hello (\d+)/g, 'Olá $1'))
})

test.each(['duplicate', 'unexpected', 'invalid-json', 'empty'])(
  'rejects %s translations without emitting an incomplete VTT', async (kind) => {
    let calls = 0
    const translate = createSubtitleTranslator({ model: 'deepseek-v4-flash', retryDelayMs: 0,
      fetch: async () => {
        calls++
        const entries = kind === 'duplicate'
          ? [{ id: 1, text: 'Olá' }, { id: 1, text: 'Outra' }]
          : kind === 'unexpected' ? [{ id: 99, text: 'Olá' }] : [{ id: 1, text: '' }]
        return Response.json({ choices: [{ message: { content: kind === 'invalid-json'
          ? '{broken' : JSON.stringify({ translations: entries }) } }] })
      },
    })
    await expect(translate(sourceVtt(1), input)).rejects.toThrow()
    expect(calls).toBe(3)
  },
)

test('backs off on rate limits and transient server errors', async () => {
  let calls = 0
  const translate = createSubtitleTranslator({ model: 'deepseek-v4-flash', retryDelayMs: 0,
    fetch: async (_, init) => {
      calls++
      if (calls === 1) return new Response('rate limit', { status: 429, headers: { 'retry-after': '0.02' } })
      if (calls === 2) return new Response('unavailable', { status: 503 })
      return translatedResponse(readRequest(init).cues)
    },
  })
  const started = performance.now()
  await translate(sourceVtt(1), input)
  expect(calls).toBe(3)
  expect(performance.now() - started).toBeGreaterThanOrEqual(15)
})

test('fails promptly for a long provider quota cooldown', async () => {
  let calls = 0
  const translate = createSubtitleTranslator({ model: 'deepseek-v4-flash', fetch: async () => {
    calls++
    return new Response('quota', { status: 429, headers: { 'retry-after': '3600' } })
  } })
  await expect(translate(sourceVtt(1), input)).rejects.toThrow('OpenCode Go 429')
  expect(calls).toBe(1)
})

test('cancels failed jobs, drains in-flight requests and releases slots for another job', async () => {
  let failedJobCalls = 0
  let active = 0
  let cancelled = 0
  const translate = createSubtitleTranslator({ model: 'deepseek-v4-flash', concurrency: 2, maxChunkCues: 1,
    fetch: async (_, init) => {
      const session = new Headers(init.headers).get('x-opencode-session')
      const cues = readRequest(init).cues
      active++
      try {
        if (session === 'failed') {
          failedJobCalls++
          if (cues[0]!.id === 1) {
            await Bun.sleep(5)
            return new Response('invalid key', { status: 401 })
          }
          await new Promise<void>((_, reject) => init.signal!.addEventListener('abort', () => {
            cancelled++
            reject(init.signal!.reason)
          }, { once: true }))
        }
        return translatedResponse(cues)
      } finally { active-- }
    },
  })
  const results = await Promise.allSettled([
    translate(sourceVtt(10), { ...input, sessionId: 'failed' }),
    translate(sourceVtt(5), { ...input, sessionId: 'healthy' }),
  ])
  expect(results[0]!.status).toBe('rejected')
  expect(results[1]!.status).toBe('fulfilled')
  expect(failedJobCalls).toBe(2)
  expect(cancelled).toBe(1)
  expect(active).toBe(0)
})

test('bounds timed-out requests and retries without leaking request slots', async () => {
  let calls = 0
  const translate = createSubtitleTranslator({ model: 'deepseek-v4-flash', requestTimeoutMs: 5, retryDelayMs: 0,
    fetch: async (_, init) => {
      calls++
      return new Promise<Response>((_, reject) => init.signal!.addEventListener('abort', () =>
        reject(init.signal!.reason), { once: true }))
    },
  })
  await expect(translate(sourceVtt(1), input)).rejects.toThrow()
  expect(calls).toBe(3)
})

test.each([0, 5001])('rejects subtitles with %i cues before contacting the provider', async (count) => {
  let calls = 0
  const translate = createSubtitleTranslator({ model: 'deepseek-v4-flash', fetch: async () => {
    calls++
    throw new Error('should not fetch')
  } })
  await expect(translate(sourceVtt(count), input)).rejects.toThrow()
  expect(calls).toBe(0)
})
