import type { TmdbSearchResult } from './tmdb'

/** Once discovered, an external identity must never be replaced by a title search. */
export async function resolveTmdbIdentity(
  content: { type: string; tmdb_id: number | null; year: number | null },
  query: string,
  search: (query: string) => Promise<TmdbSearchResult[]>,
): Promise<{ id: number; media_type: 'movie' | 'tv' } | null> {
  const media_type = content.type === 'movie' ? 'movie' : 'tv'
  if (content.tmdb_id != null) return { id: content.tmdb_id, media_type }
  const matches = (await search(query)).filter((item) => item.media_type === media_type)
  const byYear = content.year == null ? null : matches.find((item) =>
    (item.release_date ?? item.first_air_date ?? '').startsWith(String(content.year)),
  )
  const item = byYear ?? matches[0]
  return item ? { id: item.id, media_type } : null
}
