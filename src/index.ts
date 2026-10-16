import { buildApp } from './app'
import { createGoogleVerifier } from './auth/google'
import { loadConfig } from './config'
import { migrate } from './db/migrate'
import { insertGame } from './db/games'
import { createPool } from './db/pool'
import { Hub } from './online/hub'
import { EnginePool } from './engine/pool'

const config = loadConfig()
const pool = EnginePool.fromOptions(
  { binPath: config.pikafishPath, evalFile: config.pikafishEval, hashMb: config.hashMb, threads: config.threads },
  config.poolSize,
  config.maxQueue,
)

// Fail fast on a broken engine install rather than on the first player request.
await pool.warmUp()

const db = config.databaseUrl ? createPool(config.databaseUrl) : undefined
if (db) {
  const applied = await migrate(db)
  if (applied.length) console.log(`applied migrations: ${applied.join(', ')}`)
}
const googleVerifier = config.googleClientId ? createGoogleVerifier(config.googleClientId) : undefined
if (!db || !googleVerifier) console.warn('Accounts disabled: set DATABASE_URL and GOOGLE_CLIENT_ID to enable Google sign-in.')

const hub = new Hub({
  saveGame: db ? (record) => insertGame(db, record) : undefined,
  onError: (err, what) => console.error(`${what} failed:`, err),
})

const app = await buildApp({ config, searcher: pool, db, googleVerifier, hub, logger: true })

const shutdown = async (signal: string) => {
  app.log.info({ signal }, 'shutting down')
  hub.close()
  pool.close()
  await app.close()
  await db?.end()
  process.exit(0)
}
process.on('SIGINT', () => void shutdown('SIGINT'))
process.on('SIGTERM', () => void shutdown('SIGTERM'))

await app.listen({ port: config.port, host: config.host })
