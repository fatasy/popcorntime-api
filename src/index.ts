import { Elysia } from 'elysia'
import { cors } from '@elysiajs/cors'
import { swagger } from '@elysiajs/swagger'
import { env } from './env'
import { catalogRoutes } from './modules/catalog/routes'
import { subtitleRoutes } from './modules/subtitles/routes'
import { authRoutes } from './modules/auth/routes'
import { libraryRoutes } from './modules/library/routes'

const corsOrigins = env.CORS_ORIGINS
  ? env.CORS_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean)
  : false

export const app = new Elysia()
  .use(
    cors({
      origin: corsOrigins,
      methods: ['GET', 'POST', 'PUT', 'DELETE'],
      allowedHeaders: ['authorization', 'content-type'],
    }),
  )
  .use(
    swagger({
      path: '/swagger',
      documentation: {
        info: {
          title: 'PopcornTime Catalog API',
          version: '1.0.0',
          description: 'Content catalog backed by torrents, enriched via TMDB/OMDb/Jikan.',
        },
        tags: [
          { name: 'catalog', description: 'Catalog & search endpoints' },
          { name: 'auth', description: 'Accounts, profiles & JWT auth' },
          { name: 'library', description: 'Per-profile list & continue-watching' },
        ],
      },
    }),
  )
  .get('/', () => ({ name: 'PopcornTime Catalog API', status: 'ok', docs: '/swagger' }), {
    detail: { summary: 'Service info' },
  })
  .get('/health', () => ({ status: 'ok' }), { detail: { summary: 'Health check' } })
  .use(catalogRoutes)
  .use(subtitleRoutes)
  .use(authRoutes)
  .use(libraryRoutes)
  .listen(env.PORT)

console.log(`🍿 PopcornTime API running at http://localhost:${env.PORT} (docs: /swagger)`)

export type App = typeof app
