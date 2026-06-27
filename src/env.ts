import { z } from 'zod' // will be installed below

const envSchema = z.object({
  DATABASE_URL: z.string().url(),
  PORT: z.coerce.number().default(3100),
  TMDB_API_KEY: z.string().min(1),
  OMDb_API_KEY: z.string().min(1),

  // ─── Legendas (opcionais — sem chave, o provedor é apenas ignorado) ───
  // OpenSubtitles.com REST v1: registre grátis em opensubtitles.com → Perfil → API Consumers
  OPENSUBTITLES_API_KEY: z.string().min(1).optional(),
  OPENSUBTITLES_APP_NAME: z.string().default('fpopcorntime v1.0'),
  // Login opcional eleva a cota de downloads (5/dia → 20/dia no free)
  OPENSUBTITLES_USERNAME: z.string().optional(),
  OPENSUBTITLES_PASSWORD: z.string().optional(),
  // SubDL (fallback): registre em subdl.com/panel/api
  SUBDL_API_KEY: z.string().min(1).optional(),
  // Idiomas padrão da busca (canônicos), em ordem de preferência
  SUBTITLE_LANGS: z.string().default('pt-BR,pt-PT,en'),
})

export const env = envSchema.parse(process.env)
