import postgres from 'postgres'

const databaseUrl = process.env.DATABASE_URL
if (!databaseUrl) throw new Error('DATABASE_URL não configurada')
const client = postgres(databaseUrl, { max: 1, connect_timeout: 15, onnotice: () => {} })

try {
  const migration = await Bun.file(new URL('../migrations/010_http_streams.sql', import.meta.url)).text()
  await client.begin(async (transaction) => {
    await transaction.unsafe("SET LOCAL lock_timeout = '5s'; SET LOCAL statement_timeout = '30s'").simple()
    await transaction.unsafe(migration).simple()
  })
  console.log('Migração 010_http_streams aplicada com sucesso')
} finally {
  await client.end({ timeout: 5 })
}
