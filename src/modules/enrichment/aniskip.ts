// AniSkip v2 — API comunitária de "skip times" (abertura/encerramento) por anime.
// Chaveada por MAL id + número do episódio. Sem auth.
//   GET /v2/skip-times/{malId}/{episode}?types=op&types=ed&episodeLength={seg}
//   → { found, results: [{ skipType: 'op'|'ed', interval: { startTime, endTime } }] }
// op = abertura, ed = encerramento (início dos créditos = fim do conteúdo).
const BASE = 'https://api.aniskip.com/v2'

export interface AniSkipMarkers {
  introStart?: number // seg
  introEnd?: number // seg
  creditsStart?: number // seg — início dos créditos (fim do conteúdo)
}

interface SkipResult {
  skipType: 'op' | 'ed' | 'mixed-op' | 'mixed-ed' | 'recap'
  interval: { startTime: number; endTime: number }
}

/**
 * Busca os tempos de abertura/encerramento de um episódio de anime.
 * @param episodeLengthSec duração conhecida do episódio (0 = qualquer duração).
 * Retorna null quando não há dados (404/sem resultados/erro).
 */
export async function getSkipTimes(
  malId: number,
  episode: number,
  episodeLengthSec = 0,
): Promise<AniSkipMarkers | null> {
  try {
    const url = new URL(`${BASE}/skip-times/${malId}/${episode}`)
    url.searchParams.append('types', 'op')
    url.searchParams.append('types', 'ed')
    url.searchParams.set('episodeLength', String(episodeLengthSec))

    const res = await fetch(url, { signal: AbortSignal.timeout(15_000) })
    if (!res.ok) return null // 404 = sem skip times para este episódio

    const data = (await res.json()) as { found?: boolean; results?: SkipResult[] }
    if (!data.found || !data.results?.length) return null

    const out: AniSkipMarkers = {}
    for (const r of data.results) {
      if (r.skipType === 'op' || r.skipType === 'mixed-op') {
        out.introStart = r.interval.startTime
        out.introEnd = r.interval.endTime
      } else if (r.skipType === 'ed' || r.skipType === 'mixed-ed') {
        out.creditsStart = r.interval.startTime
      }
    }
    return Object.keys(out).length ? out : null
  } catch (err) {
    console.warn('[aniskip] failed:', (err as Error).message)
    return null
  }
}
