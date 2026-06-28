import { and, eq, isNull } from 'drizzle-orm'
import { db } from '../../db'
import { profiles, refresh_tokens, users } from '../../types'
import { env } from '../../env'

/** Erro de domínio de auth com status HTTP associado. */
export class AuthError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message)
    this.name = 'AuthError'
  }
}

export function normEmail(email: string): string {
  return email.trim().toLowerCase()
}

export function hashPassword(pw: string): Promise<string> {
  return Bun.password.hash(pw, { algorithm: 'argon2id' })
}

export function verifyPassword(pw: string, hash: string): Promise<boolean> {
  return Bun.password.verify(pw, hash)
}

export function sha256hex(s: string): string {
  return new Bun.CryptoHasher('sha256').update(s).digest('hex')
}

/** Token opaco aleatório (base64url). Guardamos só o sha256 dele no banco. */
export function randomToken(bytes = 32): string {
  const b = new Uint8Array(bytes)
  crypto.getRandomValues(b)
  return Buffer.from(b).toString('base64url')
}

// Hash dummy reusado para equalizar o tempo do login quando o e-mail não existe (anti-enumeração).
let DUMMY_HASH: string | null = null
async function dummyHash(): Promise<string> {
  if (!DUMMY_HASH) DUMMY_HASH = await hashPassword('dummy-password-for-constant-time-login')
  return DUMMY_HASH
}

export type AccountProfile = { id: number; name: string; avatar: string | null }

export async function getAccount(
  userId: number,
): Promise<{ user: { id: number; email: string } | null; profiles: AccountProfile[] }> {
  const u = await db
    .select({ id: users.id, email: users.email })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1)
  const ps = await db
    .select({ id: profiles.id, name: profiles.name, avatar: profiles.avatar })
    .from(profiles)
    .where(eq(profiles.user_id, userId))
    .orderBy(profiles.id)
  return { user: u[0] ?? null, profiles: ps }
}

/** Cria conta + perfil default. 409 se o e-mail já existir. */
export async function register(email: string, password: string): Promise<{ userId: number }> {
  const email_norm = normEmail(email)
  const password_hash = await hashPassword(password)
  try {
    const inserted = await db
      .insert(users)
      .values({ email: email.trim(), email_norm, password_hash })
      .returning({ id: users.id })
    const userId = inserted[0]!.id
    await db.insert(profiles).values({ user_id: userId, name: 'Perfil 1' })
    return { userId }
  } catch (e: any) {
    // só uma violação real de UNIQUE vira 409; Drizzle embrulha o erro do driver,
    // então o SQLSTATE pode estar em e.cause.code. Outros erros propagam (não mascarar).
    if (e?.code === '23505' || e?.cause?.code === '23505') {
      throw new AuthError(409, 'E-mail já cadastrado')
    }
    throw e
  }
}

/** Valida credenciais. Sempre roda um verify (dummy se o usuário não existe) p/ tempo constante. */
export async function login(email: string, password: string): Promise<{ userId: number }> {
  const email_norm = normEmail(email)
  const rows = await db.select().from(users).where(eq(users.email_norm, email_norm)).limit(1)
  const user = rows[0]
  if (!user) {
    await verifyPassword(password, await dummyHash())
    throw new AuthError(401, 'Credenciais inválidas')
  }
  const ok = await verifyPassword(password, user.password_hash)
  if (!ok) throw new AuthError(401, 'Credenciais inválidas')
  return { userId: user.id }
}

/** Emite um refresh token novo (opaco), guardando só o hash. Retorna o token cru. */
export async function issueRefresh(userId: number, familyId?: string): Promise<string> {
  const raw = randomToken()
  const token_hash = sha256hex(raw)
  const family_id = familyId ?? crypto.randomUUID()
  const expires_at = new Date(Date.now() + env.REFRESH_TTL_DAYS * 86_400_000)
  await db.insert(refresh_tokens).values({ user_id: userId, token_hash, family_id, expires_at })
  return raw
}

/**
 * Rotaciona um refresh token: invalida o atual e emite outro na mesma família.
 * Detecta reuso (token já substituído) → revoga a família inteira.
 */
export async function rotateRefresh(raw: string): Promise<{ userId: number; refreshToken: string }> {
  const token_hash = sha256hex(raw)
  const rows = await db
    .select()
    .from(refresh_tokens)
    .where(eq(refresh_tokens.token_hash, token_hash))
    .limit(1)
  const tok = rows[0]
  if (!tok) throw new AuthError(401, 'Refresh inválido')
  if (tok.revoked_at) throw new AuthError(401, 'Refresh revogado')
  if (tok.expires_at.getTime() < Date.now()) throw new AuthError(401, 'Refresh expirado')
  if (tok.replaced_at) {
    // Reuso de token já rotacionado → comprometido: revoga toda a família.
    await db
      .update(refresh_tokens)
      .set({ revoked_at: new Date() })
      .where(and(eq(refresh_tokens.family_id, tok.family_id), isNull(refresh_tokens.revoked_at)))
    throw new AuthError(401, 'Refresh reutilizado')
  }
  await db.update(refresh_tokens).set({ replaced_at: new Date() }).where(eq(refresh_tokens.id, tok.id))
  const refreshToken = await issueRefresh(tok.user_id, tok.family_id)
  return { userId: tok.user_id, refreshToken }
}

/** Revoga toda a família do refresh token informado (logout). No-op se não existir. */
export async function logout(raw: string): Promise<void> {
  const token_hash = sha256hex(raw)
  const rows = await db
    .select({ family_id: refresh_tokens.family_id })
    .from(refresh_tokens)
    .where(eq(refresh_tokens.token_hash, token_hash))
    .limit(1)
  const fam = rows[0]?.family_id
  if (!fam) return
  await db
    .update(refresh_tokens)
    .set({ revoked_at: new Date() })
    .where(and(eq(refresh_tokens.family_id, fam), isNull(refresh_tokens.revoked_at)))
}

export async function ownsProfile(userId: number, profileId: number): Promise<boolean> {
  const rows = await db
    .select({ id: profiles.id })
    .from(profiles)
    .where(and(eq(profiles.id, profileId), eq(profiles.user_id, userId)))
    .limit(1)
  return rows.length > 0
}

export async function createProfile(
  userId: number,
  name: string,
  avatar?: string | null,
): Promise<AccountProfile> {
  const rows = await db
    .insert(profiles)
    .values({ user_id: userId, name, avatar: avatar ?? null })
    .returning({ id: profiles.id, name: profiles.name, avatar: profiles.avatar })
  return rows[0]!
}

export async function updateProfile(
  userId: number,
  profileId: number,
  fields: { name?: string; avatar?: string | null },
): Promise<AccountProfile | null> {
  if (!(await ownsProfile(userId, profileId))) return null
  const patch: Partial<{ name: string; avatar: string | null }> = {}
  if (fields.name !== undefined) patch.name = fields.name
  if (fields.avatar !== undefined) patch.avatar = fields.avatar
  if (Object.keys(patch).length === 0) {
    const cur = await db
      .select({ id: profiles.id, name: profiles.name, avatar: profiles.avatar })
      .from(profiles)
      .where(eq(profiles.id, profileId))
      .limit(1)
    return cur[0] ?? null
  }
  const rows = await db
    .update(profiles)
    .set(patch)
    .where(eq(profiles.id, profileId))
    .returning({ id: profiles.id, name: profiles.name, avatar: profiles.avatar })
  return rows[0] ?? null
}

export async function deleteProfile(userId: number, profileId: number): Promise<boolean> {
  if (!(await ownsProfile(userId, profileId))) return false
  await db.delete(profiles).where(eq(profiles.id, profileId))
  return true
}
