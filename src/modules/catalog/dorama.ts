export const DORAMA_GENRE = 'Dorama'
export const DORAMA_COUNTRIES = ['KR', 'JP', 'CN', 'TW', 'HK', 'TH']
export const DORAMA_EXCLUDED_GENRES = [16, 99, 10763, 10764, 10767]

interface DoramaMetadata {
  type?: string
  original_language?: string
  origin_country?: string[]
  production_countries?: { iso_3166_1?: string }[]
  genres?: { id?: number }[]
  genre_ids?: number[]
}

/** A catalog category for scripted Asian live-action TV, including romance and thrillers. */
export function doramaGenres(item: DoramaMetadata, mediaType = 'tv'): string[] {
  if (mediaType !== 'tv') return []
  const genres = [...(item.genre_ids ?? []), ...(item.genres ?? []).map((genre) => genre.id ?? 0)]
  if (genres.some((id) => DORAMA_EXCLUDED_GENRES.includes(id))) return []
  const kind = item.type?.toLowerCase()
  if (kind && !['scripted', 'miniseries'].includes(kind)) return []
  // Older metadata may lack the TV type; require drama/comedy in that case.
  if (!kind && !genres.some((id) => [18, 35].includes(id))) return []
  const countries = item.origin_country?.length ? item.origin_country
    : (item.production_countries ?? []).flatMap((country) => country.iso_3166_1 ? [country.iso_3166_1] : [])
  const asian = countries.length ? countries.some((country) => DORAMA_COUNTRIES.includes(country))
    : ['ko', 'ja', 'zh', 'cn', 'th'].includes(item.original_language ?? '')
  return asian ? [DORAMA_GENRE] : []
}

export function isDoramaFilter(value: string): boolean {
  return /^doramas?$/i.test(value.trim())
}

/** Retain a confirmed category when another metadata provider lacks TV origin/type. */
export function preserveDoramaGenres(current: string[] | null, next: string[] | null): string[] | null {
  const merged = [...new Set([...(next ?? []), ...(current ?? []).filter((genre) => genre === DORAMA_GENRE)])]
  return merged.length ? merged : null
}
