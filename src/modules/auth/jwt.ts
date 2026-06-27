import { jwt } from '@elysiajs/jwt'
import { env } from '../../env'

// Plugin único (deduplicado por referência ao ser .use()'d em múltiplos módulos).
// Decora o contexto com `jwt.sign(payload)` e `jwt.verify(token)`.
export const jwtPlugin = jwt({ name: 'jwt', secret: env.JWT_SECRET })

// Claims do access token: sub = userId (string), pid = perfil ativo (number) ou null.
export type AccessPayload = { sub: string; pid: number | null; exp: string }
