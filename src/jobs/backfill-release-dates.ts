import { and, desc, eq, isNotNull, isNull } from 'drizzle-orm'
import { join } from 'path'
import { client, db } from '../db'
import { contents } from '../types'
import { enrichContent } from '../modules/enrichment'

function numberArg(name: string, fallback: number): number {
  const prefix = `--${name}=`
  const raw = process.argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length)
  const value = Number(raw)
  return Number.isInteger(value) && value > 0 ? value : fallback
}

const year = numberArg('year', new Date().getFullYear())
const limit = Math.min(numberArg('limit', 1_000), 5_000)

if (process.argv.includes('--migrate')) {
  const migration = join(import.meta.dir, '..', '..', 'migrations', '009_content_release_date.sql')
  await client.file(migration)
  console.log('[release-date] migration applied')
}

const candidates = await db
  .select()
  .from(contents)
  .where(and(
    eq(contents.year, year),
    isNull(contents.release_date),
    isNull(contents.canonical_content_id),
    isNotNull(contents.enriched_at),
  ))
  .orderBy(desc(contents.created_at))
  .limit(limit)

let filled = 0
let unresolved = 0

console.log(`[release-date] ${candidates.length} candidate(s) for ${year}`)
for (const [index, content] of candidates.entries()) {
  await enrichContent(content)
  const [fresh] = await db
    .select({ releaseDate: contents.release_date })
    .from(contents)
    .where(eq(contents.id, content.id))
    .limit(1)

  if (fresh?.releaseDate) filled++
  else unresolved++
  if ((index + 1) % 25 === 0 || index + 1 === candidates.length) {
    console.log(`[release-date] ${index + 1}/${candidates.length} · filled=${filled} · unresolved=${unresolved}`)
  }
}

console.log(`[release-date] done · filled=${filled} · unresolved=${unresolved}`)
await client.end()
