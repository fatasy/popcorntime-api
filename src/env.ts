import { z } from 'zod' // will be installed below

const envSchema = z.object({
  DATABASE_URL: z.string().url(),
  PORT: z.coerce.number().default(3100),
  TMDB_API_KEY: z.string().min(1),
  OMDb_API_KEY: z.string().min(1),
})

export const env = envSchema.parse(process.env)
