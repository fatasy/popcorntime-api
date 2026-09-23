import { Elysia, t } from 'elysia'
import { asc, eq } from 'drizzle-orm'
import { db } from '../../db'
import { anime_franchise_entries, contents } from '../../types'
import { env } from '../../env'
import { encodeToken, fetchVttByToken, hasProviders, searchSubtitleVariants } from './aggregator'
import type { SubtitleQuery } from './types'
import { readdirSync, existsSync } from 'fs'
import { join } from 'path'
import { resolveCanonicalContentId } from '../anime/franchise'

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
      const canonicalId = await resolveCanonicalContentId(id)
      const rows = await db.select().from(contents).where(eq(contents.id, canonicalId)).limit(1)
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
      const results = [...(await searchSubtitleVariants(variants))]

      // Adicionar legendas locais (armazenadas em local-subtitles/{contentId}/)
      const localDir = join(import.meta.dir, '..', '..', '..', 'local-subtitles', String(canonicalId))
      if (existsSync(localDir)) {
        const files = readdirSync(localDir).filter(f => f.endsWith('.srt'))
        for (const file of files) {
          const lang = file.includes('pt-BR') ? 'pt-BR' : file.includes('en') ? 'en' : 'pt-BR'
          const label = file.replace(/\.srt$/, '')
          results.push({
            provider: 'local',
            ref: `${canonicalId}:${file}`,
            lang,
            langLabel: lang === 'pt-BR' ? 'Português (Brasil)' : 'Inglês',
            release: label,
            downloads: 9999,
            rating: 10,
            hashMatch: true,
            hearingImpaired: false,
            format: 'srt',
          })
        }
        // Reordenar: hashMatch=true primeiro, depois por downloads
        results.sort((a, b) => {
          if (a.hashMatch !== b.hashMatch) return a.hashMatch ? -1 : 1
          return (b.downloads ?? 0) - (a.downloads ?? 0)
        })
      }

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
