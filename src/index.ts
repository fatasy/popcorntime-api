import { Elysia } from 'elysia'
import { cors } from '@elysiajs/cors'
import { swagger } from '@elysiajs/swagger'
import { env } from './env'
import { catalogRoutes } from './modules/catalog/routes'

export const app = new Elysia()
  .use(cors())
  .use(
    swagger({
      path: '/swagger',
      documentation: {
        info: {
          title: 'PopcornTime Catalog API',
          version: '1.0.0',
          description: 'Content catalog backed by torrents, enriched via TMDB/OMDb/Jikan.',
        },
        tags: [{ name: 'catalog', description: 'Catalog & search endpoints' }],
      },
    }),
  )
  .get('/', () => ({ name: 'PopcornTime Catalog API', status: 'ok', docs: '/swagger' }), {
    detail: { summary: 'Service info' },
  })
  .get('/health', () => ({ status: 'ok' }), { detail: { summary: 'Health check' } })
  .use(catalogRoutes)
  .listen(env.PORT)

console.log(`🍿 PopcornTime API running at http://localhost:${env.PORT} (docs: /swagger)`)

export type App = typeof app
