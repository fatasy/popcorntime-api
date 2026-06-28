import { Elysia, t } from 'elysia'
import { and, desc, eq, gt, sql } from 'drizzle-orm'
import { db } from '../../db'
import { profile_favorites, profile_progress } from '../../types'
import { jwtPlugin } from '../auth/jwt'
import { resolveProfile } from '../auth/guard'

// ─── Shapes que o app espera (FavItem / ContinueItem em src/storage.ts) ───

function toFav(row: typeof profile_favorites.$inferSelect) {
  return {
    id: row.content_id,
    title: row.title ?? '',
    poster: row.poster ?? null,
    type: row.type ?? '',
    year: row.year ?? null,
    addedAt: row.added_at ? row.added_at.getTime() : 0,
  }
}

function toProgress(row: typeof profile_progress.$inferSelect) {
  return {
    key: row.cw_key,
    title: row.title,
    poster: row.poster ?? null,
    magnet: row.magnet,
    fileIndex: row.file_index,
    position: row.position,
    duration: row.duration,
    updatedAt: row.updated_at.getTime(),
    contentId: row.content_id != null ? String(row.content_id) : undefined,
    season: row.season ?? undefined,
    episode: row.episode ?? undefined,
  }
}

// Continuar assistindo: 1 item por série (mesmo content_id) — sempre o último visto.
// As linhas chegam ordenadas por updated_at desc, então a 1ª de cada grupo é a mais
// recente. content_id null (filmes/legado) cai no cw_key e fica individual.
function dedupeLatestPerSeries(
  rows: (typeof profile_progress.$inferSelect)[],
): (typeof profile_progress.$inferSelect)[] {
  const seen = new Set<string>()
  const out: (typeof profile_progress.$inferSelect)[] = []
  for (const row of rows) {
    const groupKey = row.content_id != null ? `c:${row.content_id}` : `k:${row.cw_key}`
    if (seen.has(groupKey)) continue
    seen.add(groupKey)
    out.push(row)
  }
  return out
}

// Campos de progresso (== ContinueItem sem `key`, com `deleted` opcional p/ soft-delete).
const PROGRESS_FIELDS = {
  title: t.String(),
  poster: t.Optional(t.Union([t.String(), t.Null()])),
  magnet: t.String(),
  fileIndex: t.Number(),
  position: t.Number(),
  duration: t.Number(),
  updatedAt: t.Number(),
  contentId: t.Optional(t.String()),
  season: t.Optional(t.Number()),
  episode: t.Optional(t.Number()),
  deleted: t.Optional(t.Boolean()),
}
const ProgressBody = t.Object(PROGRESS_FIELDS)
const ProgressItem = t.Object({ key: t.String(), ...PROGRESS_FIELDS })

type ProgressInput = {
  title: string
  poster?: string | null
  magnet: string
  fileIndex: number
  position: number
  duration: number
  updatedAt: number
  contentId?: string
  season?: number
  episode?: number
  deleted?: boolean
}

function progressValues(profileId: number, cwKey: string, item: ProgressInput) {
  const cid = item.contentId != null ? Number(item.contentId) : null
  return {
    profile_id: profileId,
    cw_key: cwKey,
    content_id: cid != null && Number.isInteger(cid) ? cid : null,
    title: item.title,
    poster: item.poster ?? null,
    magnet: item.magnet,
    file_index: item.fileIndex,
    position: Math.round(item.position),
    duration: Math.round(item.duration),
    season: item.season ?? null,
    episode: item.episode ?? null,
    deleted: item.deleted ?? false,
    updated_at: new Date(item.updatedAt),
  }
}

// Upsert Last-Write-Wins: só sobrescreve se o updated_at recebido for mais novo.
const progressConflict = {
  target: [profile_progress.profile_id, profile_progress.cw_key],
  set: {
    content_id: sql`excluded.content_id`,
    title: sql`excluded.title`,
    poster: sql`excluded.poster`,
    magnet: sql`excluded.magnet`,
    file_index: sql`excluded.file_index`,
    position: sql`excluded.position`,
    duration: sql`excluded.duration`,
    season: sql`excluded.season`,
    episode: sql`excluded.episode`,
    deleted: sql`excluded.deleted`,
    updated_at: sql`excluded.updated_at`,
  },
  setWhere: sql`${profile_progress.updated_at} < excluded.updated_at`,
}

export const libraryRoutes = new Elysia({ prefix: '/me' })
  .use(jwtPlugin)
  // GET /me/library — lista + progresso do perfil ativo
  .get('/library', async ({ jwt, headers, set }) => {
    const r = await resolveProfile(jwt, headers)
    if (!r.ok) {
      set.status = r.status
      return { error: r.error }
    }
    const favs = await db
      .select()
      .from(profile_favorites)
      .where(eq(profile_favorites.profile_id, r.profileId))
      .orderBy(desc(profile_favorites.added_at))
    const prog = await db
      .select()
      .from(profile_progress)
      .where(and(eq(profile_progress.profile_id, r.profileId), eq(profile_progress.deleted, false)))
      .orderBy(desc(profile_progress.updated_at))
    return { favorites: favs.map(toFav), progress: dedupeLatestPerSeries(prog).map(toProgress) }
  }, { detail: { summary: 'Lista + progresso do perfil', tags: ['library'] } })
  // PUT /me/favorites/:contentId — adiciona à lista (idempotente)
  .put(
    '/favorites/:contentId',
    async ({ jwt, headers, set, params, body }) => {
      const r = await resolveProfile(jwt, headers)
      if (!r.ok) {
        set.status = r.status
        return { error: r.error }
      }
      const cid = Number(params.contentId)
      if (!Number.isInteger(cid)) {
        set.status = 400
        return { error: 'contentId inválido' }
      }
      await db
        .insert(profile_favorites)
        .values({
          profile_id: r.profileId,
          content_id: cid,
          title: body.title ?? null,
          poster: body.poster ?? null,
          type: body.type ?? null,
          year: body.year ?? null,
        })
        .onConflictDoNothing()
      return { added: true }
    },
    {
      params: t.Object({ contentId: t.String() }),
      body: t.Object({
        title: t.Optional(t.String()),
        poster: t.Optional(t.Union([t.String(), t.Null()])),
        type: t.Optional(t.String()),
        year: t.Optional(t.Union([t.Number(), t.Null()])),
      }),
      detail: { summary: 'Adicionar à lista', tags: ['library'] },
    },
  )
  // DELETE /me/favorites/:contentId
  .delete(
    '/favorites/:contentId',
    async ({ jwt, headers, set, params }) => {
      const r = await resolveProfile(jwt, headers)
      if (!r.ok) {
        set.status = r.status
        return { error: r.error }
      }
      const cid = Number(params.contentId)
      if (!Number.isInteger(cid)) {
        set.status = 400
        return { error: 'contentId inválido' }
      }
      await db
        .delete(profile_favorites)
        .where(and(eq(profile_favorites.profile_id, r.profileId), eq(profile_favorites.content_id, cid)))
      return { removed: true }
    },
    { params: t.Object({ contentId: t.String() }), detail: { summary: 'Remover da lista', tags: ['library'] } },
  )
  // GET /me/progress?since=<ms> — progresso (não-deletado), opcionalmente desde um timestamp
  .get(
    '/progress',
    async ({ jwt, headers, set, query }) => {
      const r = await resolveProfile(jwt, headers)
      if (!r.ok) {
        set.status = r.status
        return { error: r.error }
      }
      const conds = [
        eq(profile_progress.profile_id, r.profileId),
        eq(profile_progress.deleted, false),
      ]
      if (query.since) {
        const since = new Date(Number(query.since))
        if (!Number.isNaN(since.getTime())) conds.push(gt(profile_progress.updated_at, since))
      }
      const rows = await db
        .select()
        .from(profile_progress)
        .where(and(...conds))
        .orderBy(desc(profile_progress.updated_at))
      return rows.map(toProgress)
    },
    { query: t.Object({ since: t.Optional(t.String()) }), detail: { summary: 'Progresso do perfil', tags: ['library'] } },
  )
  // PUT /me/progress/:cwKey — upsert LWW de um item
  .put(
    '/progress/:cwKey',
    async ({ jwt, headers, set, params, body }) => {
      const r = await resolveProfile(jwt, headers)
      if (!r.ok) {
        set.status = r.status
        return { error: r.error }
      }
      const cwKey = decodeURIComponent(params.cwKey)
      await db
        .insert(profile_progress)
        .values(progressValues(r.profileId, cwKey, body))
        .onConflictDoUpdate(progressConflict)
      return { ok: true }
    },
    { params: t.Object({ cwKey: t.String() }), body: ProgressBody, detail: { summary: 'Salvar progresso (LWW)', tags: ['library'] } },
  )
  // POST /me/progress/batch — drena a fila de sync do app numa transação
  .post(
    '/progress/batch',
    async ({ jwt, headers, set, body }) => {
      const r = await resolveProfile(jwt, headers)
      if (!r.ok) {
        set.status = r.status
        return { error: r.error }
      }
      const accepted: string[] = []
      await db.transaction(async (tx) => {
        for (const item of body.items) {
          await tx
            .insert(profile_progress)
            .values(progressValues(r.profileId, item.key, item))
            .onConflictDoUpdate(progressConflict)
          accepted.push(item.key)
        }
      })
      return { accepted }
    },
    { body: t.Object({ items: t.Array(ProgressItem) }), detail: { summary: 'Sincronizar progresso em lote', tags: ['library'] } },
  )
