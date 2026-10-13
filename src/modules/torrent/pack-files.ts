import { parseRelease } from '../../lib/parse'

export interface IndexedPackEpisode { season: number; episode: number; fileIndex: number }

/** Known video filenames take precedence over a positional guess for the whole season. */
export function indexedPackEpisodes(fileList: unknown, options: {
  linkedSeason: number | null
  singleSeasonAnime: boolean
  isEpisodeFile: (name: string) => boolean
  episodeNumber: (name: string) => number | null
}): IndexedPackEpisode[] | null {
  if (!Array.isArray(fileList) || !fileList.length) return null
  const indexed: IndexedPackEpisode[] = []
  for (let index = 0; index < fileList.length; index++) {
    const file = fileList[index] as { name?: unknown; index?: unknown } | null
    if (typeof file?.name !== 'string' || !options.isEpisodeFile(file.name)) continue
    const basename = file.name.split(/[\\/]/).at(-1)!
    const episode = options.episodeNumber(basename)
    if (episode == null) continue
    const directories = file.name.split(/[\\/]/).slice(0, -1)
    const folderSeason = directories.reverse().map((name) => /^(?:season\s*|s)(\d{1,2})$/i.exec(name)?.[1])
      .find((value) => value != null)
    const season = parseRelease(basename).season ?? (folderSeason ? Number(folderSeason) : options.linkedSeason ?? 1)
    const fileIndex = typeof file.index === 'number' && Number.isInteger(file.index) && file.index >= 0 ? file.index : index
    indexed.push({ season, episode, fileIndex })
  }
  if (!indexed.length) return null
  const seasons = new Set(indexed.map((item) => item.season))
  // Donghua providers can number episodes continuously while labelling parts S1/S2.
  // Only flatten when filenames already have unique absolute numbers; never guess offsets.
  const absolute = options.singleSeasonAnime && seasons.size > 1 && seasons.has(options.linkedSeason ?? 1) &&
    new Set(indexed.map((item) => item.episode)).size === indexed.length
  return absolute ? indexed.map((item) => ({ ...item, season: options.linkedSeason ?? 1 })) : indexed
}
