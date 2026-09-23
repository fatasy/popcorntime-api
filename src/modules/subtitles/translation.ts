import { createHash, randomUUID } from 'crypto'
import { existsSync } from 'fs'
import { mkdir, rename, rm, writeFile } from 'fs/promises'
import { basename, dirname, join } from 'path'
import { fetchVttByToken } from './aggregator'

const API_URL = 'https://opencode.ai/zen/go/v1/chat/completions'
const MODEL = process.env.OPENCODE_GO_SUBTITLE_MODEL || 'deepseek-v4-pro'
const LOCAL_ROOT = join(import.meta.dir, '..', '..', '..', 'local-subtitles')
const MAX_SOURCE_BYTES = 2 * 1024 * 1024
const MAX_ACTIVE_JOBS = 2
const JOB_TTL_MS = 24 * 60 * 60 * 1000

export type SubtitleTranslationStatus =
  | 'queued'
  | 'downloading'
  | 'translating'
  | 'saving'
  | 'completed'
  | 'failed'

export interface SubtitleTranslationJobView {
  id: string
  status: SubtitleTranslationStatus
  progress: number
  targetLanguage: string
  model: string
  resultId: string
  error?: string
  createdAt: string
  updatedAt: string
}

interface SubtitleTranslationJob extends SubtitleTranslationJobView {
  userIds: Set<number>
  dedupeKey: string
  contentId: number
  season?: number
  episode?: number
  sourceToken: string
  sourceLanguage?: string
  outputPath: string
}

interface CueBlock {
  prefix: string[]
  text: string
  translationId?: number
}

interface ParsedVtt {
  header: string
  blocks: CueBlock[]
  cues: Array<{ id: number; text: string }>
}

export class SubtitleTranslationError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message)
  }
}

const jobs = new Map<string, SubtitleTranslationJob>()
const activeByKey = new Map<string, string>()

function publicJob(job: SubtitleTranslationJob): SubtitleTranslationJobView {
  return {
    id: job.id,
    status: job.status,
    progress: job.progress,
    targetLanguage: job.targetLanguage,
    model: job.model,
    resultId: job.resultId,
    error: job.error,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
  }
}

function updateJob(job: SubtitleTranslationJob, patch: Partial<SubtitleTranslationJob>): void {
  Object.assign(job, patch, { updatedAt: new Date().toISOString() })
}

function pruneJobs(): void {
  const cutoff = Date.now() - JOB_TTL_MS
  for (const [id, job] of jobs) {
    if (
      Date.parse(job.updatedAt) < cutoff &&
      job.status !== 'queued' &&
      job.status !== 'downloading' &&
      job.status !== 'translating' &&
      job.status !== 'saving'
    ) jobs.delete(id)
  }
}

async function getApiKey(): Promise<string> {
  if (process.env.OPENCODE_GO_API_KEY) return process.env.OPENCODE_GO_API_KEY
  const home = process.env.HOME || '/root'
  const file = Bun.file(join(home, '.hermes', '.env'))
  if (await file.exists()) {
    const text = await file.text()
    for (const line of text.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed.startsWith('OPENCODE_GO_API_KEY=')) continue
      const value = trimmed.slice(trimmed.indexOf('=') + 1).trim().replace(/^["']|["']$/g, '')
      if (value) return value
    }
  }
  throw new Error('OpenCode Go não está configurado na Hermes')
}

function parseVtt(vtt: string): ParsedVtt {
  const normalized = vtt.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').trim()
  const rawBlocks = normalized.split(/\n{2,}/)
  const first = rawBlocks[0]?.trim() || 'WEBVTT'
  const header = first.toUpperCase().startsWith('WEBVTT') ? rawBlocks.shift()! : 'WEBVTT'
  const blocks: CueBlock[] = []
  const cues: Array<{ id: number; text: string }> = []

  for (const raw of rawBlocks) {
    const lines = raw.split('\n')
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

function chunkCues(cues: Array<{ id: number; text: string }>): Array<Array<{ id: number; text: string }>> {
  const chunks: Array<Array<{ id: number; text: string }>> = []
  let current: Array<{ id: number; text: string }> = []
  let chars = 0
  for (const cue of cues) {
    const size = cue.text.length + 32
    if (current.length > 0 && (current.length >= 36 || chars + size > 6500)) {
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

function parseTranslationResponse(content: string): Array<{ id: number; text: string }> {
  const cleaned = content.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
  const start = cleaned.indexOf('{')
  const end = cleaned.lastIndexOf('}')
  if (start < 0 || end <= start) throw new Error('A LLM não retornou JSON válido')
  const parsed = JSON.parse(cleaned.slice(start, end + 1)) as {
    translations?: Array<{ id?: unknown; text?: unknown }>
  }
  if (!Array.isArray(parsed.translations)) throw new Error('Resposta da LLM sem traduções')
  return parsed.translations
    .filter((item): item is { id: number; text: string } =>
      Number.isInteger(item.id) && typeof item.text === 'string' && item.text.trim().length > 0,
    )
    .map((item) => ({ id: item.id, text: item.text.trim() }))
}

async function translateChunk(
  apiKey: string,
  sessionId: string,
  targetLanguage: string,
  sourceLanguage: string | undefined,
  cues: Array<{ id: number; text: string }>,
): Promise<Array<{ id: number; text: string }>> {
  const targetName = targetLanguage === 'pt-BR' ? 'Brazilian Portuguese' : targetLanguage
  const sourceHint = sourceLanguage ? `The source language is ${sourceLanguage}.` : 'Detect the source language.'
  const expected = new Set(cues.map((cue) => cue.id))
  let lastError = 'Falha desconhecida'

  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const response = await fetch(API_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          'User-Agent': 'fpopcorntime-subtitle-agent/1.0',
          'x-opencode-session': sessionId,
        },
        signal: AbortSignal.timeout(120_000),
        body: JSON.stringify({
          model: MODEL,
          messages: [
            {
              role: 'system',
              content: [
                `You are a professional audiovisual subtitle localization agent. Translate every cue to ${targetName}.`,
                sourceHint,
                'Use natural, concise dialogue that fits subtitle reading speed.',
                'Preserve character names, honorifics, fictional terms, HTML tags, line breaks, and sound-effect brackets.',
                'Never merge, split, omit, renumber, explain, or add cues.',
                'Return only one JSON object: {"translations":[{"id":1,"text":"..."}]}.',
              ].join(' '),
            },
            {
              role: 'user',
              content: JSON.stringify({ cues }),
            },
          ],
          max_tokens: 8000,
          temperature: 0.1,
        }),
      })
      if (!response.ok) {
        const body = await response.text().catch(() => '')
        throw new Error(`OpenCode Go ${response.status}: ${body.slice(0, 180)}`)
      }
      const data = await response.json() as any
      const content = String(data?.choices?.[0]?.message?.content ?? '')
      const translations = parseTranslationResponse(content)
      const translatedIds = new Set(translations.map((item) => item.id))
      if (translations.length !== cues.length || Array.from(expected).some((id) => !translatedIds.has(id))) {
        throw new Error(`A LLM retornou ${translations.length}/${cues.length} falas`)
      }
      return translations
    } catch (error) {
      lastError = (error as Error).message
      if (attempt < 2) await Bun.sleep(500)
    }
  }

  throw new Error(lastError)
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

async function runJob(job: SubtitleTranslationJob): Promise<void> {
  try {
    updateJob(job, { status: 'downloading', progress: 3 })
    const vtt = await fetchVttByToken(job.sourceToken)
    if (Buffer.byteLength(vtt, 'utf8') > MAX_SOURCE_BYTES) {
      throw new Error('A legenda é grande demais para tradução automática')
    }
    const parsed = parseVtt(vtt)
    if (parsed.cues.length === 0) throw new Error('A legenda não possui falas reconhecíveis')
    if (parsed.cues.length > 5000) throw new Error('A legenda possui falas demais para tradução automática')

    const chunks = chunkCues(parsed.cues)
    const apiKey = await getApiKey()
    const translated = new Map<number, string>()
    updateJob(job, { status: 'translating', progress: 8 })

    for (let index = 0; index < chunks.length; index++) {
      const result = await translateChunk(
        apiKey,
        job.id,
        job.targetLanguage,
        job.sourceLanguage,
        chunks[index]!,
      )
      for (const cue of result) translated.set(cue.id, cue.text)
      updateJob(job, {
        progress: 8 + Math.round(((index + 1) / chunks.length) * 86),
      })
    }

    updateJob(job, { status: 'saving', progress: 96 })
    const output = renderVtt(parsed, translated)
    const directory = dirname(job.outputPath)
    await mkdir(directory, { recursive: true })
    const tempPath = `${job.outputPath}.${job.id}.tmp`
    await writeFile(tempPath, output, 'utf8')
    await rename(tempPath, job.outputPath)
    updateJob(job, { status: 'completed', progress: 100 })
  } catch (error) {
    await rm(`${job.outputPath}.${job.id}.tmp`, { force: true }).catch(() => {})
    console.error(`[subtitle-translation] job ${job.id} failed:`, error)
    updateJob(job, {
      status: 'failed',
      error: (error as Error).message,
    })
  } finally {
    activeByKey.delete(job.dedupeKey)
  }
}

export async function startSubtitleTranslation(input: {
  userId: number
  contentId: number
  season?: number
  episode?: number
  sourceToken: string
  sourceRef: string
  sourceLanguage?: string
  targetLanguage: string
}): Promise<SubtitleTranslationJobView> {
  pruneJobs()
  const scope = input.season != null && input.episode != null
    ? `s${input.season}e${input.episode}`
    : 'movie'
  const sourceHash = createHash('sha256')
    .update(`${input.sourceRef}|${input.targetLanguage}`)
    .digest('hex')
    .slice(0, 20)
  const outputPath = join(
    LOCAL_ROOT,
    String(input.contentId),
    scope,
    `opencode-go-${input.targetLanguage}-${sourceHash}.vtt`,
  )
  const dedupeKey = `${input.contentId}:${scope}:${input.targetLanguage}:${sourceHash}`
  const activeId = activeByKey.get(dedupeKey)
  if (activeId) {
    const active = jobs.get(activeId)
    if (active) {
      active.userIds.add(input.userId)
      return publicJob(active)
    }
  }

  const now = new Date().toISOString()
  const job: SubtitleTranslationJob = {
    id: randomUUID(),
    userIds: new Set([input.userId]),
    dedupeKey,
    contentId: input.contentId,
    season: input.season,
    episode: input.episode,
    sourceToken: input.sourceToken,
    sourceLanguage: input.sourceLanguage,
    targetLanguage: input.targetLanguage,
    outputPath,
    model: MODEL,
    resultId: basename(outputPath, '.vtt'),
    status: existsSync(outputPath) ? 'completed' : 'queued',
    progress: existsSync(outputPath) ? 100 : 0,
    createdAt: now,
    updatedAt: now,
  }
  jobs.set(job.id, job)
  if (job.status === 'completed') return publicJob(job)

  const activeCount = Array.from(jobs.values()).filter((item) =>
    ['queued', 'downloading', 'translating', 'saving'].includes(item.status),
  ).length
  if (activeCount > MAX_ACTIVE_JOBS) {
    jobs.delete(job.id)
    throw new SubtitleTranslationError('Já existem traduções em andamento. Tente novamente em instantes.', 429)
  }
  if (Array.from(jobs.values()).some((item) =>
    item.id !== job.id &&
    item.userIds.has(input.userId) &&
    ['queued', 'downloading', 'translating', 'saving'].includes(item.status),
  )) {
    jobs.delete(job.id)
    throw new SubtitleTranslationError('Você já possui uma tradução em andamento.', 429)
  }

  activeByKey.set(dedupeKey, job.id)
  void runJob(job)
  return publicJob(job)
}

export function getSubtitleTranslationJob(jobId: string, userId: number): SubtitleTranslationJobView {
  pruneJobs()
  const job = jobs.get(jobId)
  if (!job || !job.userIds.has(userId)) throw new SubtitleTranslationError('Tradução não encontrada', 404)
  return publicJob(job)
}
