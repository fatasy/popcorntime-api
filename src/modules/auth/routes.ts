import { Elysia, t } from 'elysia'
import { env } from '../../env'
import { jwtPlugin } from './jwt'
import { resolveAuth } from './guard'
import { clientIp, rateLimit } from './rate-limit'
import * as svc from './service'

// jwt.sign() type não é exportado; usamos o tipo do decorator via parâmetro.
type Signer = { sign: (payload: Record<string, any>) => Promise<string> }

function signAccess(jwt: Signer, userId: number, pid: number | null): Promise<string> {
  return jwt.sign({ sub: String(userId), pid, exp: env.ACCESS_TTL })
}

const EmailBody = t.Object({
  email: t.String({ minLength: 3, maxLength: 320 }),
  password: t.String({ minLength: 8, maxLength: 200 }),
})

export const authRoutes = new Elysia({ prefix: '/auth' })
  .use(jwtPlugin)
  // POST /auth/register
  .post(
    '/register',
    async ({ body, jwt, set }) => {
      try {
        const { userId } = await svc.register(body.email, body.password)
        const account = await svc.getAccount(userId)
        const accessToken = await signAccess(jwt, userId, null)
        const refreshToken = await svc.issueRefresh(userId)
        return { accessToken, refreshToken, user: account.user, profiles: account.profiles }
      } catch (e) {
        if (e instanceof svc.AuthError) {
          set.status = e.status
          return { error: e.message }
        }
        throw e
      }
    },
    { body: EmailBody, detail: { summary: 'Criar conta', tags: ['auth'] } },
  )
  // POST /auth/login
  .post(
    '/login',
    async ({ body, jwt, set, headers }) => {
      const key = `${clientIp(headers)}:${svc.normEmail(body.email)}`
      const rl = rateLimit(key)
      if (!rl.ok) {
        set.status = 429
        if (rl.retryAfter) set.headers['retry-after'] = String(rl.retryAfter)
        return { error: 'Muitas tentativas. Tente novamente mais tarde.' }
      }
      try {
        const { userId } = await svc.login(body.email, body.password)
        const account = await svc.getAccount(userId)
        const accessToken = await signAccess(jwt, userId, null)
        const refreshToken = await svc.issueRefresh(userId)
        return { accessToken, refreshToken, user: account.user, profiles: account.profiles }
      } catch (e) {
        if (e instanceof svc.AuthError) {
          set.status = e.status
          return { error: e.message }
        }
        throw e
      }
    },
    { body: EmailBody, detail: { summary: 'Login', tags: ['auth'] } },
  )
  // POST /auth/refresh — rotaciona o refresh e emite novo access (opcionalmente já com perfil)
  .post(
    '/refresh',
    async ({ body, jwt, set }) => {
      try {
        const { userId, refreshToken } = await svc.rotateRefresh(body.refreshToken)
        let pid: number | null = null
        if (body.pid != null) {
          if (await svc.ownsProfile(userId, body.pid)) pid = body.pid
          else {
            set.status = 403
            return { error: 'Perfil não pertence à conta' }
          }
        }
        const accessToken = await signAccess(jwt, userId, pid)
        return { accessToken, refreshToken }
      } catch (e) {
        if (e instanceof svc.AuthError) {
          set.status = e.status
          return { error: e.message }
        }
        throw e
      }
    },
    {
      body: t.Object({ refreshToken: t.String(), pid: t.Optional(t.Number()) }),
      detail: { summary: 'Rotacionar tokens', tags: ['auth'] },
    },
  )
  // POST /auth/logout — revoga a família do refresh
  .post(
    '/logout',
    async ({ body }) => {
      await svc.logout(body.refreshToken)
      return { ok: true }
    },
    { body: t.Object({ refreshToken: t.String() }), detail: { summary: 'Logout', tags: ['auth'] } },
  )
  // GET /auth/me — conta + perfis
  .get('/me', async ({ jwt, headers, set }) => {
    const r = await resolveAuth(jwt, headers)
    if (!r.ok) {
      set.status = r.status
      return { error: r.error }
    }
    const account = await svc.getAccount(r.userId)
    if (!account.user) {
      set.status = 404
      return { error: 'Conta não encontrada' }
    }
    return { id: account.user.id, email: account.user.email, profiles: account.profiles }
  }, { detail: { summary: 'Conta + perfis', tags: ['auth'] } })
  // POST /auth/profiles — cria perfil
  .post(
    '/profiles',
    async ({ jwt, headers, set, body }) => {
      const r = await resolveAuth(jwt, headers)
      if (!r.ok) {
        set.status = r.status
        return { error: r.error }
      }
      const p = await svc.createProfile(r.userId, body.name, body.avatar)
      return p
    },
    {
      body: t.Object({
        name: t.String({ minLength: 1, maxLength: 64 }),
        avatar: t.Optional(t.String({ maxLength: 32 })),
      }),
      detail: { summary: 'Criar perfil', tags: ['auth'] },
    },
  )
  // DELETE /auth/profiles/:id
  .delete(
    '/profiles/:id',
    async ({ jwt, headers, set, params }) => {
      const r = await resolveAuth(jwt, headers)
      if (!r.ok) {
        set.status = r.status
        return { error: r.error }
      }
      const id = Number(params.id)
      if (!Number.isInteger(id)) {
        set.status = 400
        return { error: 'id inválido' }
      }
      const ok = await svc.deleteProfile(r.userId, id)
      if (!ok) {
        set.status = 403
        return { error: 'Perfil não pertence à conta' }
      }
      return { ok: true }
    },
    { params: t.Object({ id: t.String() }), detail: { summary: 'Excluir perfil', tags: ['auth'] } },
  )
  // POST /auth/profiles/:id/select — emite access token com o perfil ativo (claim pid)
  .post(
    '/profiles/:id/select',
    async ({ jwt, headers, set, params }) => {
      const r = await resolveAuth(jwt, headers)
      if (!r.ok) {
        set.status = r.status
        return { error: r.error }
      }
      const id = Number(params.id)
      if (!Number.isInteger(id)) {
        set.status = 400
        return { error: 'id inválido' }
      }
      if (!(await svc.ownsProfile(r.userId, id))) {
        set.status = 403
        return { error: 'Perfil não pertence à conta' }
      }
      const accessToken = await signAccess(jwt, r.userId, id)
      return { accessToken }
    },
    {
      params: t.Object({ id: t.String() }),
      detail: { summary: 'Selecionar perfil (token com pid)', tags: ['auth'] },
    },
  )
