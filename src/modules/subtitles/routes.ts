import { Elysia, t } from 'elysia'
import { eq } from 'drizzle-orm'
import { db } from '../../db'
import { contents } from '../../types'
import { env } from '../../env'
import { encodeToken, fetchVttByToken, hasProviders, searchSubtitles } from './aggregator'
import type { SubtitleQuery } from './types'

const DEFAULT_LANGS = env.SUBTITLE_LANGS.split(',')
  .map((s) => s.trim())
  .filter(Boolean)

export const subtitleRoutes = new Elysia()
  // GET /catalog/:id/subtitles — lista legendas (multi-fonte) p/ um conteúdo
  .get(
    '/catalog/:id/subtitles',
    async ({ params, query, request, set }) => {
      const id = Number(params.id)
      if (!Number.isInteger(id)) {
        set.status = 400
        return { error: 'Invalid id' }
      }
      const rows = await db.select().from(contents).where(eq(contents.id, id)).limit(1)
      const content = rows[0]
      if (!content) {
        set.status = 404
        return { error: 'Content not found' }
      }
      if (!hasProviders()) {
        set.status = 503
        return { error: 'Nenhum provedor de legenda configurado (defina OPENSUBTITLES_API_KEY)' }
      }

      const langs = query.lang
        ? query.lang.split(',').map((s) => s.trim()).filter(Boolean)
        : DEFAULT_LANGS

      const q: SubtitleQuery = {
        type: content.type === 'series' ? 'series' : 'movie',
        imdbId: content.imdb_id ?? undefined,
        tmdbId: content.tmdb_id ?? undefined,
        title: content.title,
        year: content.year ?? undefined,
        languages: langs,
        season: query.season != null ? Number(query.season) : undefined,
        episode: query.episode != null ? Number(query.episode) : undefined,
      }

      const results = await searchSubtitles(q)
      const origin = new URL(request.url).origin
      const data = results.map((r) => ({
        lang: r.lang,
        langLabel: r.langLabel,
        release: r.release,
        downloads: r.downloads,
        hashMatch: r.hashMatch,
        hearingImpaired: r.hearingImpaired,
        provider: r.provider,
        url: `${origin}/subtitles/file/${encodeToken(r)}/s.vtt`,
      }))
      return { data, meta: { count: data.length, languages: langs } }
    },
    {
      params: t.Object({ id: t.String() }),
      query: t.Object({
        season: t.Optional(t.Numeric()),
        episode: t.Optional(t.Numeric()),
        lang: t.Optional(t.String()),
      }),
      detail: { summary: 'List subtitles (pt-BR, multi-source) for a content', tags: ['catalog'] },
    },
  )
  // GET /subtitles/file/:token/s.vtt — serve a legenda já normalizada (UTF-8 WebVTT)
  .get(
    '/subtitles/file/:token/s.vtt',
    async ({ params, set }) => {
      try {
        const vtt = await fetchVttByToken(params.token)
        set.headers['content-type'] = 'text/vtt; charset=utf-8'
        set.headers['cache-control'] = 'public, max-age=86400'
        return vtt
      } catch (e: any) {
        set.status = 502
        set.headers['content-type'] = 'text/vtt; charset=utf-8'
        return `WEBVTT\n\nNOTE erro ao obter legenda: ${e?.message ?? e}\n`
      }
    },
    {
      params: t.Object({ token: t.String() }),
      detail: { summary: 'Serve a normalized UTF-8 WebVTT subtitle', tags: ['catalog'] },
    },
  )
