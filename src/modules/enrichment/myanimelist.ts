// Jikan v4 — unofficial MyAnimeList API, no auth required.
const BASE = 'https://api.jikan.moe/v4'

export interface JikanAnime {
  mal_id: number
  title?: string
  title_english?: string | null
  title_japanese?: string | null
  synopsis?: string | null
  score?: number | null
  episodes?: number | null
  status?: string | null
  duration?: string | null
  year?: number | null
  images?: { jpg?: { image_url?: string; large_image_url?: string } }
  genres?: { name: string }[]
  studios?: { name: string }[]
  type?: string | null
  aired?: {
    from?: string | null
    prop?: { from?: { year?: number | null } }
  }
}

export interface JikanRelationEntry {
  mal_id: number
  type: string
  name: string
}

export interface JikanAnimeFull extends JikanAnime {
  relations?: { relation: string; entry: JikanRelationEntry[] }[]
}

export interface JikanEpisode {
  mal_id: number
  title?: string | null
  title_romanji?: string | null
  title_japanese?: string | null
  aired?: string | null
  filler?: boolean | null
  recap?: boolean | null
}

function anilistDate(date?: { year?: number | null; month?: number | null; day?: number | null }): string | null {
  if (!date?.year) return null
  return `${date.year}-${String(date.month ?? 1).padStart(2, '0')}-${String(date.day ?? 1).padStart(2, '0')}`
}

/**
 * Fallback de busca. O AniList devolve `idMal`, portanto o restante do fluxo
 * continua usando o MAL/Jikan como identidade e consolidando as temporadas.
 */
async function searchAnimeViaAniList(query: string, limit: number): Promise<JikanAnime[]> {
  try {
    const res = await fetch('https://graphql.anilist.co', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({
        query: `
          query SearchAnime($search: String!, $perPage: Int!) {
            Page(page: 1, perPage: $perPage) {
              media(search: $search, type: ANIME, isAdult: false, sort: SEARCH_MATCH) {
                idMal
                title { romaji english native }
                description(asHtml: false)
                averageScore episodes duration seasonYear format
                startDate { year month day }
                coverImage { large extraLarge }
                genres
                studios(isMain: true) { nodes { name } }
              }
            }
          }
        `,
        variables: { search: query, perPage: Math.min(20, Math.max(1, limit)) },
      }),
      signal: AbortSignal.timeout(15_000),
    })
    if (!res.ok) {
      console.warn(`[anilist] HTTP ${res.status} for "${query}"`)
      return []
    }
    const json = (await res.json()) as {
      data?: {
        Page?: {
          media?: Array<{
            idMal?: number | null
            title?: { romaji?: string | null; english?: string | null; native?: string | null }
            description?: string | null
            averageScore?: number | null
            episodes?: number | null
            duration?: number | null
            seasonYear?: number | null
            format?: string | null
            startDate?: { year?: number | null; month?: number | null; day?: number | null }
            coverImage?: { large?: string | null; extraLarge?: string | null }
            genres?: string[] | null
            studios?: { nodes?: { name: string }[] }
          }>
        }
      }
    }
    return (json.data?.Page?.media ?? [])
      .filter((item): item is typeof item & { idMal: number } => typeof item.idMal === 'number')
      .map((item) => ({
        mal_id: item.idMal,
        title: item.title?.romaji ?? item.title?.english ?? undefined,
        title_english: item.title?.english ?? null,
        title_japanese: item.title?.native ?? null,
        synopsis: item.description?.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() ?? null,
        score: item.averageScore != null ? item.averageScore / 10 : null,
        episodes: item.episodes ?? null,
        duration: item.duration != null ? `${item.duration} min per ep` : null,
        year: item.seasonYear ?? item.startDate?.year ?? null,
        images: {
          jpg: {
            image_url: item.coverImage?.large ?? undefined,
            large_image_url: item.coverImage?.extraLarge ?? item.coverImage?.large ?? undefined,
          },
        },
        genres: item.genres?.map((name) => ({ name })) ?? [],
        studios: item.studios?.nodes ?? [],
        type: item.format === 'TV' || item.format === 'TV_SHORT' ? 'TV' : item.format ?? null,
        aired: {
          from: anilistDate(item.startDate),
          prop: { from: { year: item.startDate?.year ?? null } },
        },
      }))
  } catch (err) {
    console.warn('[anilist] search failed:', (err as Error).message)
    return []
  }
}

/** Search anime by title, with AniList fallback when Jikan search is unavailable. */
export async function searchAnime(query: string, limit = 5): Promise<JikanAnime[]> {
  try {
    const url = new URL(BASE + '/anime')
    url.searchParams.set('q', query)
    url.searchParams.set('limit', String(limit))
    url.searchParams.set('sfw', 'true')

    const res = await fetch(url, { signal: AbortSignal.timeout(15_000) })
    if (!res.ok) {
      console.warn(`[jikan] HTTP ${res.status} for "${query}"`)
      return searchAnimeViaAniList(query, limit)
    }
    const data = (await res.json()) as { data?: JikanAnime[] }
    return data.data ?? []
  } catch (err) {
    console.warn('[jikan] search failed:', (err as Error).message)
    return searchAnimeViaAniList(query, limit)
  }
}

/** Fetch a single anime by MAL id. */
export async function getAnime(id: number): Promise<JikanAnime | null> {
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const res = await fetch(`${BASE}/anime/${id}`, {
        signal: AbortSignal.timeout(15_000),
      })
      if (res.ok) {
        const data = (await res.json()) as { data?: JikanAnime }
        return data.data ?? null
      }
      if (res.status !== 429 && res.status < 500) return null
      console.warn(`[jikan] getAnime mal:${id} HTTP ${res.status} (attempt ${attempt}/4)`)
    } catch (err) {
      console.warn(
        `[jikan] getAnime mal:${id} failed (attempt ${attempt}/4):`,
        (err as Error).message,
      )
    }
    if (attempt < 4) await new Promise((resolve) => setTimeout(resolve, attempt * 1_000))
  }
  return null
}

/** Fetch metadata plus MAL relations (used to join seasons into one title). */
export async function getAnimeFull(id: number): Promise<JikanAnimeFull | null> {
  // O endpoint `/full` do Jikan retorna 504 para alguns registros válidos.
  // Combinar os dois endpoints menores é mais confiável e contém os mesmos
  // campos necessários para montar a franquia.
  const anime = await getAnime(id)
  if (!anime) return null
  await new Promise((resolve) => setTimeout(resolve, 350))

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(`${BASE}/anime/${id}/relations`, {
        signal: AbortSignal.timeout(15_000),
      })
      if (res.ok) {
        const data = (await res.json()) as { data?: JikanAnimeFull['relations'] }
        return { ...anime, relations: data.data ?? [] }
      }
      if (res.status !== 429 && res.status < 500) return null
      console.warn(`[jikan] getAnimeFull mal:${id} HTTP ${res.status} (attempt ${attempt}/3)`)
    } catch (err) {
      console.warn(
        `[jikan] getAnimeFull mal:${id} failed (attempt ${attempt}/3):`,
        (err as Error).message,
      )
    }
    if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, attempt * 750))
  }

  // O inverso também acontece em alguns IDs: `/relations` falha e `/full`
  // responde normalmente (ex.: MAL 59970). Tenta a representação completa
  // como fallback, mantendo a regra de nunca devolver uma cadeia parcial.
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(`${BASE}/anime/${id}/full`, {
        signal: AbortSignal.timeout(15_000),
      })
      if (res.ok) {
        const data = (await res.json()) as { data?: JikanAnimeFull }
        return data.data ?? null
      }
      if (res.status !== 429 && res.status < 500) return null
      console.warn(`[jikan] getAnimeFull fallback mal:${id} HTTP ${res.status} (attempt ${attempt}/3)`)
    } catch (err) {
      console.warn(
        `[jikan] getAnimeFull fallback mal:${id} failed (attempt ${attempt}/3):`,
        (err as Error).message,
      )
    }
    if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, attempt * 750))
  }
  return null
}

// ─── Aired-episode count (for ongoing anime gap detection) ──────────────────

function maxEpisodeNumber(list?: { episode?: number }[]): number {
  let m = 0
  for (const e of list ?? []) {
    if (typeof e.episode === 'number' && e.episode > m) m = e.episode
  }
  return m
}

/**
 * Latest episode number that has aired, via Jikan /anime/{id}/episodes.
 * MAL's `episodes` field is usually null while a show is still airing, so this
 * is the reliable way to know how far a weekly seasonal anime has come.
 * Fetches page 1 and (if paginated) the last page, bounded to ~2 requests.
 */
export async function getAnimeAiredEpisodeCount(id: number): Promise<number | null> {
  try {
    const p1 = await fetch(`${BASE}/anime/${id}/episodes`, {
      signal: AbortSignal.timeout(15_000),
    })
    if (!p1.ok) return null
    const j1 = (await p1.json()) as {
      data?: { episode?: number }[]
      pagination?: { last_visible_page?: number; has_next_page?: boolean }
    }
    let max = maxEpisodeNumber(j1.data)
    const lastPage = j1.pagination?.last_visible_page ?? 1
    if (j1.pagination?.has_next_page && lastPage > 1) {
      await new Promise((r) => setTimeout(r, 350)) // Jikan rate limit
      const last = await fetch(`${BASE}/anime/${id}/episodes?page=${lastPage}`, {
        signal: AbortSignal.timeout(15_000),
      })
      if (last.ok) {
        const jl = (await last.json()) as { data?: { episode?: number }[] }
        max = Math.max(max, maxEpisodeNumber(jl.data))
      }
    }
    return max || null
  } catch (err) {
    console.warn('[jikan] episodes failed:', (err as Error).message)
    return null
  }
}

/**
 * Catálogo completo de episódios de um anime. É usado na atualização manual
 * para que a tela mostre também episódios ainda sem torrent disponível.
 */
export async function getAnimeEpisodes(id: number): Promise<JikanEpisode[]> {
  const episodes: JikanEpisode[] = []
  let page = 1

  try {
    while (page <= 100) {
      const res = await fetch(`${BASE}/anime/${id}/episodes?page=${page}`, {
        signal: AbortSignal.timeout(15_000),
      })
      if (!res.ok) {
        console.warn(`[jikan] episodes page ${page} HTTP ${res.status} for mal:${id}`)
        break
      }
      const json = (await res.json()) as {
        data?: JikanEpisode[]
        pagination?: { has_next_page?: boolean }
      }
      episodes.push(...(json.data ?? []))
      if (!json.pagination?.has_next_page) break
      page++
      await new Promise((resolve) => setTimeout(resolve, 350))
    }
  } catch (err) {
    console.warn(`[jikan] episode catalog failed for mal:${id}:`, (err as Error).message)
  }

  return episodes
}

// ─── Discovery endpoints ─────────────────────────────────────────────

/** Currently airing seasonal anime. */
export async function getSeasonNow(): Promise<JikanAnime[]> {
  try {
    const res = await fetch(`${BASE}/seasons/now?sfw=true`, {
      signal: AbortSignal.timeout(20_000),
    })
    if (!res.ok) {
      console.warn(`[jikan] seasons/now HTTP ${res.status}`)
      return []
    }
    const data = (await res.json()) as { data?: JikanAnime[] }
    return data.data ?? []
  } catch (err) {
    console.warn('[jikan] seasons/now failed:', (err as Error).message)
    return []
  }
}

/** Top airing anime. */
export async function getTopAiring(limit = 25): Promise<JikanAnime[]> {
  try {
    const url = new URL(BASE + '/top/anime')
    url.searchParams.set('filter', 'airing')
    url.searchParams.set('limit', String(limit))
    url.searchParams.set('sfw', 'true')
    const res = await fetch(url, { signal: AbortSignal.timeout(15_000) })
    if (!res.ok) {
      console.warn(`[jikan] top/anime HTTP ${res.status}`)
      return []
    }
    const data = (await res.json()) as { data?: JikanAnime[] }
    return data.data ?? []
  } catch (err) {
    console.warn('[jikan] top/airing failed:', (err as Error).message)
    return []
  }
}
