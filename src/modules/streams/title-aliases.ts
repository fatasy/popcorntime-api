function key(value: string): string {
  return value.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
}

/** A provider label can contain two actual names; season qualifiers remain intact. */
export function expandAnimeTitleAliases(titles: (string | null | undefined)[]): string[] {
  const result = new Map<string, string>()
  const add = (value: string) => {
    const normalized = key(value)
    if (normalized && !result.has(normalized)) result.set(normalized, value.trim())
  }
  for (const value of titles) {
    if (!value?.trim()) continue
    const parts = [...value.matchAll(/\[([^\]]+)\]|\(([^)]+)\)/g)]
    const aliases = parts.map((part) => (part[1] ?? part[2] ?? '').trim())
    const alternate = aliases.length > 0 && aliases.every((alias) =>
      key(alias).length >= 6 && !/\b(?:season|temporada|part|cour|movie|ova|ona|tv|dubbed|subbed|final|complete|\d{4})\b/i.test(alias),
    )
    if (alternate) {
      add(value.replace(/\[[^\]]+\]|\([^)]+\)/g, ' ').replace(/\s+/g, ' ').trim())
      aliases.forEach(add)
    }
    add(value)
  }
  return [...result.values()]
}

export function providerAnimeAliases(payload: { results?: { title?: string; type?: string }[] }): string[] {
  return (payload.results ?? []).filter((item) => !item.type?.toLowerCase().includes('source material'))
    .flatMap((item) => item.title?.trim() ? [item.title.trim()] : [])
}

export function animeSourceQueries(titles: string[], limit = 6): string[] {
  const expanded = expandAnimeTitleAliases(titles)
  // A composite label remains an accepted match but need not consume a search slot.
  const plain = expanded.filter((title) => !/[\[(]/.test(title))
  const queries = plain.length ? plain : expanded
  return [...queries.filter((title) => /[a-z]/i.test(title)),
    ...queries.filter((title) => !/[a-z]/i.test(title))].slice(0, limit)
}

export function animeTorrentQueries(titles: string[], limit = 4): string[] {
  const queries = animeSourceQueries(titles, 100)
  const primary = queries[0]
  // Very short alternate English names can match unrelated anime or reality shows.
  const ambiguous = new Set(['big brother', 'senior brother', 'brother', 'my brother'])
  return queries.filter((title) => !ambiguous.has(key(title)) &&
    (title === primary || !/[a-z]/i.test(title) || key(title).split(' ').length >= 2)).slice(0, limit)
}

/** Search engines can return similarly named works; require a complete known title. */
export function animeTorrentMatchesTitle(release: string, titles: string[]): boolean {
  const normalized = release.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/[^\p{L}\p{N}\[\]()|–-]+/gu, ' ').replace(/\s+/g, ' ')
  return animeTorrentQueries(titles, 100).some((title) => {
    const escaped = key(title).split(' ').map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[\\s–-]+')
    if (!escaped) return false
    return new RegExp(`(?:^|[\\s|\\[\\]\\(\\)])${escaped}(?=$|[\\[(|]|\\s+(?:[\\[(|]|[-–]\\s*(?:s\\d|e\\d|\\d)|s\\d|e\\d|season\\b|episode\\b|ep\\b|batch\\b|complete\\b|vostfr\\b|web\\b|blu\\b|raw\\b|dub\\b|sub\\b|\\d{2,4}\\b))`, 'iu').test(normalized)
  })
}
