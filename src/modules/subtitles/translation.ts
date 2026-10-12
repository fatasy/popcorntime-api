import { createHash, randomUUID } from 'crypto'
import { existsSync } from 'fs'
import { mkdir, rename, rm, writeFile } from 'fs/promises'
import { basename, dirname, join } from 'path'
import { fetchVttByToken } from './aggregator'
import { createSubtitleTranslator } from './translation-engine'

const MODEL = process.env.OPENCODE_GO_SUBTITLE_MODEL || 'deepseek-v4-flash'
const LOCAL_ROOT = join(import.meta.dir, '..', '..', '..', 'local-subtitles')
const MAX_SOURCE_BYTES = 2 * 1024 * 1024
const MAX_ACTIVE_JOBS = 2
const JOB_TTL_MS = 24 * 60 * 60 * 1000
const translateVtt = createSubtitleTranslator({
  model: MODEL,
  concurrency: Number(process.env.OPENCODE_GO_SUBTITLE_CONCURRENCY),
  maxChunkCues: Number(process.env.OPENCODE_GO_SUBTITLE_BATCH_CUES),
})

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

async function runJob(job: SubtitleTranslationJob): Promise<void> {
  const started = performance.now()
  try {
    updateJob(job, { status: 'downloading', progress: 3 })
    const vtt = await fetchVttByToken(job.sourceToken)
    if (Buffer.byteLength(vtt, 'utf8') > MAX_SOURCE_BYTES) {
      throw new Error('A legenda é grande demais para tradução automática')
    }
    const downloadMs = Math.round(performance.now() - started)
    const apiKey = await getApiKey()
    updateJob(job, { status: 'translating', progress: 8 })
    const output = await translateVtt(vtt, {
      apiKey,
      sessionId: job.id,
      targetLanguage: job.targetLanguage,
      sourceLanguage: job.sourceLanguage,
      onProgress: (completed, total) => updateJob(job, {
        progress: 8 + Math.round((completed / total) * 86),
      }),
      onBatch: (batch) => console.info(`[subtitle-translation] job ${job.id} batch`, batch),
    })

    updateJob(job, { status: 'saving', progress: 96 })
    const directory = dirname(job.outputPath)
    await mkdir(directory, { recursive: true })
    const tempPath = `${job.outputPath}.${job.id}.tmp`
    await writeFile(tempPath, output, 'utf8')
    await rename(tempPath, job.outputPath)
    updateJob(job, { status: 'completed', progress: 100 })
    console.info(`[subtitle-translation] job ${job.id} completed`, {
      model: job.model,
      downloadMs,
      totalMs: Math.round(performance.now() - started),
    })
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
