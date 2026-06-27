// Rate-limit em memória (single-instance). Para multi-instância, trocar por Redis.
type Bucket = { count: number; resetAt: number }
const buckets = new Map<string, Bucket>()

const WINDOW_MS = 15 * 60_000
const MAX_ATTEMPTS = 10

export function clientIp(headers: Record<string, string | undefined>): string {
  const xff = headers['x-forwarded-for']
  if (xff) return xff.split(',')[0]!.trim()
  return 'unknown'
}

/** Conta uma tentativa para a chave. Retorna { ok:false, retryAfter } quando estoura. */
export function rateLimit(key: string): { ok: boolean; retryAfter?: number } {
  const now = Date.now()
  const b = buckets.get(key)
  if (!b || b.resetAt < now) {
    buckets.set(key, { count: 1, resetAt: now + WINDOW_MS })
    return { ok: true }
  }
  if (b.count >= MAX_ATTEMPTS) {
    return { ok: false, retryAfter: Math.ceil((b.resetAt - now) / 1000) }
  }
  b.count++
  return { ok: true }
}
