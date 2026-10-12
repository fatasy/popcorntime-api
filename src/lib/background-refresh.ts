/** Bounded refreshes shared by requests, with a cooldown after each attempt. */
export class BackgroundRefreshQueue {
  private active = 0
  private jobs: (() => void)[] = []
  private pending = new Map<string, Promise<unknown>>()
  private retryAt = new Map<string, number>()

  constructor(
    private readonly concurrency = 1,
    private readonly cooldownMs = 5 * 60_000,
    private readonly onError: (key: string, error: unknown) => void = () => {},
  ) {}

  run<T>(key: string, refresh: () => Promise<T>): Promise<T> {
    const existing = this.pending.get(key)
    if (existing) return existing as Promise<T>
    let resolve!: (value: T) => void
    let reject!: (error: unknown) => void
    const result = new Promise<T>((ok, fail) => { resolve = ok; reject = fail })
    this.pending.set(key, result)
    this.jobs.push(() => {
      this.active++
      const finish = () => {
        this.active--
        this.pending.delete(key)
        this.retryAt.set(key, Date.now() + this.cooldownMs)
        this.drain()
      }
      void Promise.resolve().then(refresh).then(
        (value) => { resolve(value); finish() },
        (error) => { reject(error); finish() },
      )
    })
    this.drain()
    return result
  }

  schedule<T>(key: string, refresh: () => Promise<T>): Promise<T> | null {
    const existing = this.pending.get(key)
    if (existing) return existing as Promise<T>
    if ((this.retryAt.get(key) ?? 0) > Date.now()) return null
    const result = this.run(key, refresh)
    void result.catch((error) => this.onError(key, error))
    return result
  }

  private drain(): void {
    while (this.active < this.concurrency && this.jobs.length > 0) this.jobs.shift()!()
  }
}

export interface ExternalCacheEntry<T> { value: T; cachedAt: Date }

/** Serve stale catalog data immediately; a slow provider never blocks a cache hit. */
export async function readExternalCatalog<T>(options: {
  key: string
  queue: BackgroundRefreshQueue
  read: () => Promise<ExternalCacheEntry<T> | null>
  refresh: () => Promise<T>
  ttlMs: number
  force?: boolean
  coldWaitMs?: number
}): Promise<T | null> {
  const cached = await options.read()
  if (options.force) {
    try { return await options.queue.run(options.key, options.refresh) }
    catch { return cached?.value ?? null }
  }
  if (cached && Date.now() - cached.cachedAt.getTime() < options.ttlMs) return cached.value
  const refresh = options.queue.schedule(options.key, options.refresh)
  if (cached) return cached.value
  if (!refresh || !options.coldWaitMs) return null

  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      refresh.catch(() => null),
      new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), options.coldWaitMs) }),
    ])
  } finally { clearTimeout(timer) }
}
