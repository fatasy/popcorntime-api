import { Elysia, t } from 'elysia'
import { resolveHttpStream } from './service'
import { httpProviderMetadata } from './providers'

export const streamRoutes = new Elysia()
  .get('/streams/providers', () => ({ data: httpProviderMetadata() }), {
    detail: { summary: 'List HTTP anime sources', tags: ['streams'] },
  })
  .get('/streams/:id/resolve', async ({ params, set }) => {
    const id = Number(params.id)
    set.headers['cache-control'] = 'no-store'
    if (!Number.isSafeInteger(id) || id < 1) {
      set.status = 400
      return { error: 'Invalid stream id' }
    }
    try {
      const stream = await resolveHttpStream(id)
      if (!stream) { set.status = 404; return { error: 'Stream not found' } }
      return stream
    } catch (error) {
      set.status = 502
      return { error: (error as Error).message }
    }
  }, { params: t.Object({ id: t.String() }), detail: { summary: 'Resolve a fresh direct playback URL', tags: ['streams'] } })
