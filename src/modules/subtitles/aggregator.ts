import { langPriority } from './lang'
import { normalizeToVtt } from './normalize'
import { openSubtitlesProvider } from './providers/opensubtitles'
import { subdlProvider } from './providers/subdl'
import type { SubtitleProvider, SubtitleQuery, SubtitleResult } from './types'

const PROVIDERS: SubtitleProvider[] = [openSubtitlesProvider, subdlProvider]
const PER_PROVIDER_TIMEOUT = 9000
const SEARCH_TTL = 6 * 60 * 60 * 1000 // 6h

function activeProviders(): SubtitleProvider[] {
  return PROVIDERS.filter((p) => p.enabled)
}

export function hasProviders(): boolean {
  return activeProviders().length > 0
}

// Ranking: hash-match > pt-BR > pt-PT > en > resto > mais baixadas > melhor rating
function rank(a: SubtitleResult, b: SubtitleResult): number {
  if (a.hashMatch !== b.hashMatch) return a.hashMatch ? -1 : 1
  const pa = langPriority(a.lang)
  const pb = langPriority(b.lang)
  if (pa !== pb) return pa - pb
  if (a.downloads !== b.downloads) return b.downloads - a.downloads
  return b.rating - a.rating
}

const searchCache = new Map<string, { at: number; results: SubtitleResult[] }>()

function cacheKey(q: SubtitleQuery): string {
  return [q.type, q.imdbId ?? '', q.tmdbId ?? '', q.season ?? '', q.episode ?? '', [...q.languages].sort().join('+')].join('|')
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error('timeout')), ms)),
  ])
}

export async function searchSubtitles(q: SubtitleQuery): Promise<SubtitleResult[]> {
  const key = cacheKey(q)
  const hit = searchCache.get(key)
  if (hit && Date.now() - hit.at < SEARCH_TTL) return hit.results

  const settled = await Promise.allSettled(
    activeProviders().map((p) => withTimeout(p.search(q), PER_PROVIDER_TIMEOUT)),
  )
  const merged: SubtitleResult[] = []
  for (const s of settled) if (s.status === 'fulfilled') merged.push(...s.value)

  // dedup por provider+ref
  const seen = new Set<string>()
  const deduped = merged.filter((r) => {
    const k = `${r.provider}:${r.ref}`
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })

  deduped.sort(rank)
  searchCache.set(key, { at: Date.now(), results: deduped })
  return deduped
}

// ─── Token opaco p/ a URL de download (esconde provider/ref do cliente) ───
export function encodeToken(r: SubtitleResult): string {
  return Buffer.from(JSON.stringify({ p: r.provider, r: r.ref }), 'utf8').toString('base64url')
}
function decodeToken(token: string): { p: string; r: string } {
  return JSON.parse(Buffer.from(token, 'base64url').toString('utf8'))
}

// Cache do arquivo já normalizado (VTT UTF-8). Arquivos não mudam → cache permanente (com teto).
const fileCache = new Map<string, string>()

export async function fetchVttByToken(token: string): Promise<string> {
  const cached = fileCache.get(token)
  if (cached) return cached
  const { p, r } = decodeToken(token)
  const provider = PROVIDERS.find((x) => x.id === p)
  if (!provider) throw new Error(`provider desconhecido: ${p}`)
  const raw = await provider.fetchFile(r)
  const vtt = normalizeToVtt(raw)
  if (fileCache.size > 500) fileCache.clear()
  fileCache.set(token, vtt)
  return vtt
}
