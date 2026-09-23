import { Elysia, t } from 'elysia'
import { asc, eq } from 'drizzle-orm'
import { db } from '../../db'
import { anime_franchise_entries, contents } from '../../types'
import { env } from '../../env'
import {
  decodeTranslationSource,
  encodeToken,
  encodeTranslationSource,
  fetchVttByToken,
  hasProviders,
  searchSubtitleVariants,
} from './aggregator'
import type { SubtitleQuery, SubtitleResult } from './types'
import { readdirSync, existsSync } from 'fs'
import { join, relative } from 'path'
import { resolveCanonicalContentId } from '../anime/franchise'
import { jwtPlugin } from '../auth/jwt'
import { resolveAuth } from '../auth/guard'
import {
  getSubtitleTranslationJob,
  startSubtitleTranslation,
  SubtitleTranslationError,
} from './translation'

const DEFAULT_LANGS = env.SUBTITLE_LANGS.split(',')
  .map((s) => s.trim())
  .filter(Boolean)

function localLanguage(filename: string): string {
  const normalized = filename.toLowerCase()
  if (normalized.includes('pt-br') || normalized.includes('pob')) return 'pt-BR'
  if (normalized.includes('pt-pt') || normalized.includes('por')) return 'pt-PT'
  if (normalized.includes('-en-') || normalized.includes('.en.')) return 'en'
  if (normalized.includes('-es-') || normalized.includes('.es.')) return 'es'
  return 'pt-BR'
}

function localLanguageLabel(lang: string): string {
  if (lang === 'pt-BR') return 'Português (Brasil)'
  if (lang === 'pt-PT') return 'Português (Portugal)'
  if (lang === 'en') return 'Inglês'
  if (lang === 'es') return 'Espanhol'
  return lang
}

function localSubtitleResults(
  contentId: number,
  season?: number,
  episode?: number,
): SubtitleResult[] {
  const root = join(import.meta.dir, '..', '..', '..', 'local-subtitles', String(contentId))
  const directories = [root]
  if (season != null && episode != null) directories.push(join(root, `s${season}e${episode}`))
  const seen = new Set<string>()
  const results: SubtitleResult[] = []

  for (const directory of directories) {
    if (!existsSync(directory)) continue
    const files = readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isFile() && /\.(srt|vtt)$/i.test(entry.name))
    for (const entry of files) {
      const absolute = join(directory, entry.name)
      const refPath = relative(root, absolute).replace(/\\/g, '/')
      if (seen.has(refPath)) continue
      seen.add(refPath)
      const lang = localLanguage(entry.name)
      const generated = entry.name.toLowerCase().startsWith('opencode-go-')
      results.push({
        provider: generated ? 'opencode-go' : 'local',
        ref: `${contentId}:${refPath}`,
        lang,
        langLabel: localLanguageLabel(lang),
        release: generated
          ? `Tradução OpenCode Go · ${localLanguageLabel(lang)}`
          : entry.name.replace(/\.(srt|vtt)$/i, ''),
        downloads: 9999,
        rating: 10,
        hashMatch: true,
        hearingImpaired: false,
        format: entry.name.toLowerCase().endsWith('.vtt') ? 'vtt' : 'srt',
      })
    }
  }

  return results
}

export const subtitleRoutes = new Elysia()
  .use(jwtPlugin)
  // GET /catalog/:id/subtitles — lista legendas (multi-fonte) p/ um conteúdo
  .get(
    '/catalog/:id/subtitles',
    async ({ params, query, request, set }) => {
      const id = Number(params.id)
      if (!Number.isInteger(id)) {
        set.status = 400
        return { error: 'Invalid id' }
      }
      const canonicalId = await resolveCanonicalContentId(id)
      const rows = await db.select().from(contents).where(eq(contents.id, canonicalId)).limit(1)
      const content = rows[0]
      if (!content) {
        set.status = 404
        return { error: 'Content not found' }
      }
      const langs = query.lang
        ? query.lang.split(',').map((s) => s.trim()).filter(Boolean)
        : DEFAULT_LANGS

      const season = query.season != null ? Number(query.season) : undefined
      const episode = query.episode != null ? Number(query.episode) : undefined
      const q: SubtitleQuery = {
        type: content.type === 'movie' ? 'movie' : 'series',  // anime, series → series
        isAnime: content.type === 'anime',
        imdbId: content.imdb_id ?? undefined,
        tmdbId: content.tmdb_id ?? undefined,
        title: content.title,
        year: content.year ?? undefined,
        languages: langs,
        season,
        episode,
      }

      const variants: SubtitleQuery[] = [q]
      if (content.type === 'anime' && season != null && episode != null) {
        const franchise = await db
          .select()
          .from(anime_franchise_entries)
          .where(eq(anime_franchise_entries.content_id, canonicalId))
          .orderBy(
            asc(anime_franchise_entries.season_number),
            asc(anime_franchise_entries.part_number),
          )
        const entry = franchise
          .filter((item) => item.season_number === season)
          .sort((a, b) => b.episode_offset - a.episode_offset)
          .find(
            (item) =>
              episode > item.episode_offset &&
              (item.episode_count == null ||
                episode <= item.episode_offset + item.episode_count),
          )

        if (entry) {
          const localEpisode = Math.max(1, episode - entry.episode_offset)
          const seasonalTitles = Array.from(
            new Set([entry.title, entry.title_english].filter((title): title is string => !!title?.trim())),
          )
          for (const title of seasonalTitles) {
            // Usa o título próprio da temporada/parte e reinicia o episódio,
            // mas mantém a temporada lógica como filtro de segurança. Sem o
            // filtro, o OpenSubtitles pode ignorar o título e devolver qualquer
            // série que tenha o mesmo número de episódio.
            variants.push({
              type: 'series',
              isAnime: true,
              title,
              year: entry.year ?? content.year ?? undefined,
              languages: langs,
              season,
              episode: localEpisode,
            })
          }
        }
      }

      // Copiar o array para não mutar caches compartilhados pelo agregador.
      const results = hasProviders()
        ? [...(await searchSubtitleVariants(variants))]
        : []
      results.push(...localSubtitleResults(canonicalId, season, episode))
      results.sort((a, b) => {
        if (a.hashMatch !== b.hashMatch) return a.hashMatch ? -1 : 1
        return (b.downloads ?? 0) - (a.downloads ?? 0)
      })

      // Atrás de proxy TLS, request.url chega como http — respeite os headers encaminhados.
      const u = new URL(request.url)
      const proto = request.headers.get('x-forwarded-proto')?.split(',')[0]?.trim() || u.protocol.replace(':', '')
      const host = request.headers.get('x-forwarded-host')?.split(',')[0]?.trim() || u.host
      const origin = `${proto}://${host}`
      const data = results.map((r) => ({
        lang: r.lang,
        langLabel: r.langLabel,
        release: r.release,
        downloads: r.downloads,
        hashMatch: r.hashMatch,
        hearingImpaired: r.hearingImpaired,
        provider: r.provider,
        url: `${origin}/subtitles/file/${encodeToken(r)}/s.vtt`,
        translationId: r.provider === 'opencode-go'
          ? r.ref.split('/').at(-1)?.replace(/\.vtt$/i, '')
          : undefined,
        translationRef: encodeTranslationSource(r, {
          contentId: canonicalId,
          season,
          episode,
        }),
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
  // POST /catalog/:id/subtitles/translate — cria uma tradução persistente em
  // background usando a conta OpenCode Go configurada na Hermes.
  .post(
    '/catalog/:id/subtitles/translate',
    async ({ params, body, jwt, headers, set }) => {
      const auth = await resolveAuth(jwt, headers)
      if (!auth.ok) {
        set.status = auth.status
        return { error: auth.error }
      }
      const requestedId = Number(params.id)
      if (!Number.isInteger(requestedId)) {
        set.status = 400
        return { error: 'Invalid id' }
      }
      const contentId = await resolveCanonicalContentId(requestedId)
      const [content] = await db
        .select({ type: contents.type })
        .from(contents)
        .where(eq(contents.id, contentId))
        .limit(1)
      if (!content) {
        set.status = 404
        return { error: 'Content not found' }
      }

      try {
        const source = decodeTranslationSource(body.sourceRef)
        const season = body.season != null ? Number(body.season) : undefined
        const episode = body.episode != null ? Number(body.episode) : undefined
        if (
          source.contentId !== contentId ||
          source.season !== season ||
          source.episode !== episode
        ) throw new SubtitleTranslationError('A fonte não pertence a este conteúdo', 400)
        if (
          content.type !== 'movie' &&
          (!Number.isInteger(season) || !Number.isInteger(episode) || season! < 1 || episode! < 0)
        ) throw new SubtitleTranslationError('Temporada ou episódio inválido', 400)
        if (source.lang === body.targetLanguage) {
          throw new SubtitleTranslationError('A legenda já está no idioma solicitado', 400)
        }

        return await startSubtitleTranslation({
          userId: auth.userId,
          contentId,
          season,
          episode,
          sourceToken: source.token,
          sourceRef: body.sourceRef,
          sourceLanguage: source.lang,
          targetLanguage: body.targetLanguage,
        })
      } catch (error) {
        const known = error instanceof SubtitleTranslationError
        set.status = known ? error.status : 400
        return { error: (error as Error).message }
      }
    },
    {
      params: t.Object({ id: t.String() }),
      body: t.Object({
        sourceRef: t.String({ minLength: 20, maxLength: 16000 }),
        targetLanguage: t.Literal('pt-BR'),
        season: t.Optional(t.Numeric()),
        episode: t.Optional(t.Numeric()),
      }),
      detail: { summary: 'Translate an existing subtitle with OpenCode Go', tags: ['catalog'] },
    },
  )
  .get(
    '/subtitles/translate/:jobId',
    async ({ params, jwt, headers, set }) => {
      const auth = await resolveAuth(jwt, headers)
      if (!auth.ok) {
        set.status = auth.status
        return { error: auth.error }
      }
      try {
        return getSubtitleTranslationJob(params.jobId, auth.userId)
      } catch (error) {
        const known = error instanceof SubtitleTranslationError
        set.status = known ? error.status : 400
        return { error: (error as Error).message }
      }
    },
    {
      params: t.Object({ jobId: t.String() }),
      detail: { summary: 'Get OpenCode Go subtitle translation progress', tags: ['catalog'] },
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
