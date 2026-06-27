import { ownsProfile } from './service'

// Estrutura mínima do que precisamos do contexto Elysia (decorado com jwt pelo jwtPlugin).
type JwtLike = { verify: (token?: string) => Promise<any> }
type HeadersLike = Record<string, string | undefined>

function bearer(headers: HeadersLike): string | undefined {
  const h = headers['authorization'] ?? headers['Authorization']
  if (!h) return undefined
  return h.startsWith('Bearer ') ? h.slice(7) : undefined
}

export type Authed = { userId: number; pid: number | null }

/** Verifica o access token. Retorna null se ausente/ inválido. */
export async function authenticate(jwt: JwtLike, headers: HeadersLike): Promise<Authed | null> {
  const token = bearer(headers)
  if (!token) return null
  const payload = await jwt.verify(token)
  if (!payload || payload.sub == null) return null
  const userId = Number(payload.sub)
  if (!Number.isInteger(userId)) return null
  const rawPid = payload.pid
  const pid = rawPid == null ? null : Number(rawPid)
  return { userId, pid: pid != null && Number.isInteger(pid) ? pid : null }
}

export type AuthOutcome =
  | { ok: true; userId: number; pid: number | null }
  | { ok: false; status: 401; error: string }

/** Exige um access token válido (qualquer perfil, ou nenhum). */
export async function resolveAuth(jwt: JwtLike, headers: HeadersLike): Promise<AuthOutcome> {
  const a = await authenticate(jwt, headers)
  if (!a) return { ok: false, status: 401, error: 'Não autenticado' }
  return { ok: true, userId: a.userId, pid: a.pid }
}

export type ProfileOutcome =
  | { ok: true; userId: number; profileId: number }
  | { ok: false; status: 401 | 403; error: string }

/** Exige token válido COM perfil selecionado e que o perfil pertença à conta (anti-IDOR). */
export async function resolveProfile(jwt: JwtLike, headers: HeadersLike): Promise<ProfileOutcome> {
  const a = await authenticate(jwt, headers)
  if (!a) return { ok: false, status: 401, error: 'Não autenticado' }
  if (a.pid == null) return { ok: false, status: 401, error: 'Selecione um perfil' }
  if (!(await ownsProfile(a.userId, a.pid)))
    return { ok: false, status: 403, error: 'Perfil não pertence à conta' }
  return { ok: true, userId: a.userId, profileId: a.pid }
}
