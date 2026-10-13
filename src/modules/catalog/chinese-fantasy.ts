export const CHINESE_FANTASY_LABEL = 'Xianxia / Wuxia'
export const CHINESE_FANTASY_GENRES = ['Xianxia', 'Wuxia']
export const CHINESE_FANTASY_KEYWORD_IDS = [234890, 184656, 377550, 384653]

interface Metadata {
  original_language?: string
  origin_country?: string[]
  production_countries?: { iso_3166_1?: string; name?: string }[]
  genres?: { id?: number; name?: string }[]
  genre_ids?: number[]
  keywords?: { results?: { id?: number; name?: string }[]; keywords?: { id?: number; name?: string }[] }
}

export function isChineseProduction(item: Metadata): boolean {
  return item.original_language === 'zh' || item.original_language === 'cn' ||
    (item.origin_country ?? []).some((country) => ['CN', 'HK', 'TW'].includes(country)) ||
    (item.production_countries ?? []).some((country) =>
      ['CN', 'HK', 'TW'].includes(country.iso_3166_1 ?? ''),
    )
}

export function isChineseAnimation(item: Metadata): boolean {
  return isChineseProduction(item) && (
    item.genre_ids?.includes(16) === true || item.genres?.some((genre) => genre.id === 16) === true
  )
}

/** Chinese origin alone, fantasy alone, and generic martial arts never classify a work. */
export function chineseFantasyGenres(item: Metadata): string[] {
  if (!isChineseProduction(item)) return []
  const keywords = item.keywords?.results ?? item.keywords?.keywords ?? []
  const ids = new Set(keywords.map((keyword) => keyword.id))
  const names = new Set(keywords.map((keyword) => keyword.name?.trim().toLowerCase()))
  const genres: string[] = []
  const cultivation = ids.has(377550) || names.has('cultivation')
  const fantasy = (item.genres ?? []).some((genre) => [16, 14, 10765].includes(genre.id ?? 0)) ||
    (item.genre_ids ?? []).some((id) => [16, 14, 10765].includes(id))
  if (ids.has(234890) || names.has('xianxia') || names.has('xinxia') ||
      (cultivation && fantasy) || ids.has(384653) || names.has('xianxia and wuxia')) genres.push('Xianxia')
  if (ids.has(184656) || names.has('wuxia') || ids.has(384653) || names.has('xianxia and wuxia')) genres.push('Wuxia')
  return genres
}

export function chineseFantasyFilterGenres(value: string): string[] | null {
  const normalized = value.trim().toLowerCase().replace(/[\s/_-]+/g, '')
  if (normalized === 'xianxia') return ['Xianxia']
  if (normalized === 'wuxia') return ['Wuxia']
  return normalized === 'xianxiawuxia' ? CHINESE_FANTASY_GENRES : null
}

/** Keep confirmed category tags when an older metadata cache lacks keywords. */
export function preserveChineseFantasyGenres(current: string[] | null, next: string[] | null): string[] | null {
  const retained = (current ?? []).filter((genre) => CHINESE_FANTASY_GENRES.includes(genre))
  const merged = [...new Set([...(next ?? []), ...retained])]
  return merged.length ? merged : null
}
