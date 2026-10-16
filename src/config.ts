import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
/** Server package root: `src/..` in dev and `dist/..` once bundled. */
export const serverRoot = resolve(here, '..')

const int = (name: string, fallback: number, min: number, max: number): number => {
  const raw = process.env[name]
  if (raw === undefined || raw === '') return fallback
  const n = Number(raw)
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${name} must be an integer in [${min}, ${max}]`)
  return n
}

export interface Config {
  port: number
  host: string
  /** Browser origins allowed to call the API cross-origin (CORS) and to send state-changing requests. */
  allowedOrigins: string[]
  pikafishPath: string
  pikafishEval: string
  poolSize: number
  maxQueue: number
  hashMb: number
  threads: number
  /** Honour X-Forwarded-For (only enable behind a trusted reverse proxy such as Caddy). */
  trustProxy: boolean
  /** Requests per minute per client for /api/bestmove. */
  bestMoveRatePerMin: number
  /** Postgres connection string; without it accounts (and later online play) are disabled. */
  databaseUrl: string | null
  /** Google OAuth client id; without it the login button is hidden. */
  googleClientId: string | null
  /** Mark cookies Secure (HTTPS only). On by default in production. */
  cookieSecure: boolean
  /** Concurrent WebSocket connections allowed per client IP. */
  maxConnsPerIp: number
}

export function loadConfig(): Config {
  return {
    port: int('PORT', 3001, 1, 65535),
    host: process.env.HOST || '0.0.0.0',
    allowedOrigins: (process.env.ALLOWED_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean),
    pikafishPath: process.env.PIKAFISH_PATH || resolve(serverRoot, 'engine/pikafish'),
    pikafishEval: process.env.PIKAFISH_EVAL || resolve(serverRoot, 'engine/pikafish.nnue'),
    poolSize: int('ENGINE_POOL_SIZE', 2, 1, 64),
    maxQueue: int('ENGINE_MAX_QUEUE', 32, 0, 10_000),
    hashMb: int('ENGINE_HASH_MB', 32, 1, 4096),
    threads: int('ENGINE_THREADS', 1, 1, 64),
    trustProxy: process.env.TRUST_PROXY === 'true',
    bestMoveRatePerMin: int('BESTMOVE_RATE_PER_MIN', 60, 1, 100_000),
    databaseUrl: process.env.DATABASE_URL || null,
    googleClientId: process.env.GOOGLE_CLIENT_ID || null,
    maxConnsPerIp: int('MAX_WS_CONNS_PER_IP', 20, 1, 10_000),
    cookieSecure: process.env.COOKIE_SECURE ? process.env.COOKIE_SECURE === 'true' : process.env.NODE_ENV === 'production',
  }
}
