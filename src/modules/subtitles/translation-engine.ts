const API_URL = 'https://opencode.ai/zen/go/v1/chat/completions'

interface Cue {
  id: number
  text: string
}

interface CueBlock {
  prefix: string[]
  text: string
  translationId?: number
}

interface ParsedVtt {
  header: string
  blocks: CueBlock[]
  cues: Cue[]
}

interface TranslationInput {
  apiKey: string
  sessionId: string
  targetLanguage: string
  sourceLanguage?: string
  onProgress?: (completedCues: number, totalCues: number) => void
  onBatch?: (batch: {
    attempt: number
    cues: number
    translated: number
    durationMs: number
    reasoningChars: number
  }) => void
}

interface TranslatorOptions {
  model: string
  concurrency?: number
  maxChunkCues?: number
  maxChunkChars?: number
  requestTimeoutMs?: number
  retryDelayMs?: number
  fetch?: (url: string, init: RequestInit) => Promise<Response>
}

function boundedInteger(value: number | undefined, fallback: number, min: number, max: number): number {
  return value != null && Number.isInteger(value) && value >= min
    ? Math.min(value, max)
    : fallback
}

function parseVtt(vtt: string): ParsedVtt {
  const normalized = vtt.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').trim()
  const rawBlocks = normalized.split(/\n{2,}/)
  const first = rawBlocks[0]?.trim() || 'WEBVTT'
  const header = first.toUpperCase().startsWith('WEBVTT') ? rawBlocks.shift()! : 'WEBVTT'
  const blocks: CueBlock[] = []
  const cues: Cue[] = []

  for (const raw of rawBlocks) {
    const lines = raw.split('\n')
    // Metadata blocks may themselves contain arrows; they are not dialogue.
    if (/^(NOTE(?:\s|$)|STYLE(?:\s|$)|REGION(?:\s|$))/.test(lines[0] || '')) {
      blocks.push({ prefix: lines, text: '' })
      continue
    }
    const timingIndex = lines.findIndex((line) => line.includes('-->'))
    if (timingIndex < 0 || timingIndex === lines.length - 1) {
      blocks.push({ prefix: lines, text: '' })
      continue
    }
    const text = lines.slice(timingIndex + 1).join('\n').trim()
    if (!text) {
      blocks.push({ prefix: lines, text: '' })
      continue
    }
    const id = cues.length + 1
    cues.push({ id, text })
    blocks.push({ prefix: lines.slice(0, timingIndex + 1), text, translationId: id })
  }

  return { header, blocks, cues }
}

function chunkCues(cues: Cue[], maxCues: number, maxChars: number): Cue[][] {
  const chunks: Cue[][] = []
  let current: Cue[] = []
  let chars = 0
  for (const cue of cues) {
    const size = cue.text.length + 32
    if (current.length > 0 && (current.length >= maxCues || chars + size > maxChars)) {
      chunks.push(current)
      current = []
      chars = 0
    }
    current.push(cue)
    chars += size
  }
  if (current.length > 0) chunks.push(current)
  return chunks
}

function parseTranslationResponse(content: string, expected: Set<number>): Cue[] {
  const cleaned = content.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
  const start = cleaned.indexOf('{')
  const end = cleaned.lastIndexOf('}')
  if (start < 0 || end <= start) throw new Error('A LLM não retornou JSON válido')
  const parsed = JSON.parse(cleaned.slice(start, end + 1)) as {
    translations?: Array<{ id?: unknown; text?: unknown } | null>
  } | null
  if (!Array.isArray(parsed?.translations)) throw new Error('Resposta da LLM sem traduções')
  const seen = new Set<number>()
  const translations: Cue[] = []
  for (const item of parsed.translations) {
    if (!item || !Number.isInteger(item.id) || typeof item.text !== 'string') {
      throw new Error('Resposta da LLM com fala inválida')
    }
    const id = item.id as number
    if (!expected.has(id) || seen.has(id)) throw new Error('Resposta da LLM com IDs inválidos')
    seen.add(id)
    if (item.text.trim()) translations.push({ id, text: item.text.trim() })
  }
  return translations
}

// One limiter per translator, shared by all jobs, including retry requests.
class RequestLimiter {
  private active = 0
  private waiting: Array<() => void> = []

  constructor(private readonly limit: number) {}

  async run<T>(signal: AbortSignal, task: () => Promise<T>): Promise<T> {
    signal.throwIfAborted()
    await new Promise<void>((resolve, reject) => {
      const grant = () => {
        signal.removeEventListener('abort', cancel)
        this.active++
        resolve()
      }
      const cancel = () => {
        const index = this.waiting.indexOf(grant)
        if (index >= 0) this.waiting.splice(index, 1)
        reject(signal.reason)
      }
      if (this.active < this.limit) grant()
      else {
        this.waiting.push(grant)
        signal.addEventListener('abort', cancel, { once: true })
      }
    })
    try {
      signal.throwIfAborted()
      return await task()
    } finally {
      this.active--
      this.waiting.shift()?.()
    }
  }
}

class ProviderError extends Error {
  constructor(message: string, readonly status: number, readonly retryAfterMs?: number) {
    super(message)
  }
}

function retryAfterMs(response: Response): number | undefined {
  const value = response.headers.get('retry-after')
  if (!value) return undefined
  const seconds = Number(value)
  const ms = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(value) - Date.now()
  return Number.isFinite(ms) ? Math.max(0, ms) : undefined
}

function waitForRetry(ms: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    const cancel = () => {
      clearTimeout(timer)
      reject(signal.reason)
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', cancel)
      resolve()
    }, ms)
    signal.addEventListener('abort', cancel, { once: true })
  })
}

async function withRequestTimeout<T>(
  signal: AbortSignal,
  timeoutMs: number,
  task: (requestSignal: AbortSignal) => Promise<T>,
): Promise<T> {
  const timeout = new AbortController()
  const timer = setTimeout(() => timeout.abort(new DOMException('Tempo limite da tradução excedido', 'TimeoutError')),
    timeoutMs)
  try {
    return await task(AbortSignal.any([signal, timeout.signal]))
  } finally {
    clearTimeout(timer)
  }
}

function renderVtt(parsed: ParsedVtt, translations: Map<number, string>): string {
  const blocks = parsed.blocks.map((block) => {
    if (block.translationId == null) return block.prefix.join('\n')
    const translated = translations.get(block.translationId)
    if (!translated) throw new Error(`Tradução ausente para a fala ${block.translationId}`)
    return [...block.prefix, translated].join('\n')
  })
  return [parsed.header, ...blocks].join('\n\n').trim() + '\n'
}

export function createSubtitleTranslator(options: TranslatorOptions) {
  const concurrency = boundedInteger(options.concurrency, 4, 1, 8)
  const maxChunkCues = boundedInteger(options.maxChunkCues, 72, 1, 120)
  const maxChunkChars = boundedInteger(options.maxChunkChars, 12000, 1000, 16000)
  const requestTimeoutMs = boundedInteger(options.requestTimeoutMs, 60000, 1, 180000)
  const retryDelayMs = boundedInteger(options.retryDelayMs, 500, 0, 5000)
  const fetcher = options.fetch ?? ((url, init) => fetch(url, init))
  const limiter = new RequestLimiter(concurrency)

  async function translateChunk(
    input: TranslationInput,
    cues: Cue[],
    context: { before: Cue[]; after: Cue[] },
    signal: AbortSignal,
  ): Promise<Cue[]> {
    const targetName = input.targetLanguage === 'pt-BR' ? 'Brazilian Portuguese' : input.targetLanguage
    const sourceHint = input.sourceLanguage
      ? `The source language is ${input.sourceLanguage}.`
      : 'Detect the source language.'
    const translated = new Map<number, string>()
    let pending = cues
    let lastError: unknown = new Error('Falha desconhecida')

    for (let attempt = 1; attempt <= 3; attempt++) {
      signal.throwIfAborted()
      let delay = retryDelayMs * attempt
      try {
        const result = await limiter.run(signal, () => withRequestTimeout(signal, requestTimeoutMs, async (requestSignal) => {
          const started = performance.now()
          const response = await fetcher(API_URL, {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${input.apiKey}`,
              'Content-Type': 'application/json',
              'User-Agent': 'fpopcorntime-subtitle-agent/1.0',
              'x-opencode-session': input.sessionId,
            },
            signal: requestSignal,
            body: JSON.stringify({
              model: options.model,
              messages: [
                {
                  role: 'system',
                  content: [
                    `You are a professional audiovisual subtitle localization agent. Translate every cue to ${targetName}.`,
                    sourceHint,
                    'Use natural, concise dialogue that fits subtitle reading speed.',
                    'Preserve character names, honorifics, fictional terms, HTML tags, line breaks, and sound-effect brackets.',
                    'Never merge, split, omit, renumber, explain, or add cues.',
                    'Use the surrounding context only as a reference; translate only the entries in cues.',
                    'Return only one JSON object: {"translations":[{"id":1,"text":"..."}]}.',
                  ].join(' '),
                },
                { role: 'user', content: JSON.stringify({
                  context: pending.length < cues.length ? { ...context, originalCues: cues } : context,
                  cues: pending,
                }) },
              ],
              max_tokens: 8000,
              temperature: 0.1,
              response_format: { type: 'json_object' },
              // OpenCode Go uses reasoning_effort, rather than DeepSeek's thinking field.
              ...(/^deepseek-/i.test(options.model) ? { reasoning_effort: 'none' } : {}),
            }),
          })
          if (!response.ok) {
            const body = await response.text().catch(() => '')
            throw new ProviderError(`OpenCode Go ${response.status}: ${body.slice(0, 180)}`,
              response.status, retryAfterMs(response))
          }
          const data = await response.json() as {
            choices?: Array<{ message?: { content?: string; reasoning_content?: string } }>
          }
          const message = data?.choices?.[0]?.message
          const translations = parseTranslationResponse(String(message?.content ?? ''),
            new Set(pending.map((cue) => cue.id)))
          input.onBatch?.({
            attempt,
            cues: pending.length,
            translated: translations.length,
            durationMs: Math.round(performance.now() - started),
            reasoningChars: message?.reasoning_content?.length ?? 0,
          })
          return translations
        }))
        for (const cue of result) translated.set(cue.id, cue.text)
        pending = pending.filter((cue) => !translated.has(cue.id))
        if (pending.length === 0) return cues.map((cue) => ({ id: cue.id, text: translated.get(cue.id)! }))
        lastError = new Error(`A LLM retornou ${translated.size}/${cues.length} falas`)
      } catch (error) {
        signal.throwIfAborted()
        if (error instanceof ProviderError) {
          const retryable = error.status === 408 || error.status === 429 || error.status >= 500
          // Fail promptly on auth/configuration errors or long quota cooldowns.
          if (!retryable || (error.retryAfterMs ?? 0) > 30000) throw error
          delay = error.retryAfterMs ?? delay
        }
        lastError = error
      }
      if (attempt < 3) await waitForRetry(delay, signal)
    }
    throw lastError
  }

  return async (vtt: string, input: TranslationInput): Promise<string> => {
    const parsed = parseVtt(vtt)
    if (parsed.cues.length === 0) throw new Error('A legenda não possui falas reconhecíveis')
    if (parsed.cues.length > 5000) throw new Error('A legenda possui falas demais para tradução automática')
    const chunks = chunkCues(parsed.cues, maxChunkCues, maxChunkChars)
    const translations = new Map<number, string>()
    const controller = new AbortController()
    let nextIndex = 0
    let completedCues = 0

    const worker = async () => {
      try {
        while (nextIndex < chunks.length) {
          controller.signal.throwIfAborted()
          const index = nextIndex++
          const chunk = chunks[index]!
          const start = chunk[0]!.id - 1
          const result = await translateChunk(input, chunk, {
            before: parsed.cues.slice(Math.max(0, start - 2), start),
            after: parsed.cues.slice(start + chunk.length, start + chunk.length + 2),
          }, controller.signal)
          controller.signal.throwIfAborted()
          for (const cue of result) translations.set(cue.id, cue.text)
          completedCues += result.length
          input.onProgress?.(completedCues, parsed.cues.length)
        }
      } catch (error) {
        controller.abort(error)
        throw error
      }
    }

    // Drain cancelled workers before the caller marks the job failed or releases its dedupe key.
    await Promise.allSettled(Array.from({ length: Math.min(concurrency, chunks.length) }, worker))
    controller.signal.throwIfAborted()
    return renderVtt(parsed, translations)
  }
}
