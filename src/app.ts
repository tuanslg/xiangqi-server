import cookie from '@fastify/cookie'
import cors from '@fastify/cors'
import rateLimit from '@fastify/rate-limit'
import { allLegalMoves, fenProblem, parseFen, toUciFen } from '@xiangqi/shared'
import Fastify from 'fastify'
import type { FastifyError, FastifyInstance } from 'fastify'
import { registerAuth } from './auth/routes'
import type { GoogleVerifier } from './auth/google'
import type { Config } from './config'
import type { Db } from './db/pool'
import { EngineBusyError } from './engine/pool'
import type { Searcher } from './engine/pool'
import { LEVELS, firstLegal, getLevel, pickMove } from './engine/levels'
import { registerGuestCookie } from './online/guest'
import type { Hub } from './online/hub'
import { registerOnline } from './online/ws'
import { registerOriginCheck } from './security'

export interface AppDeps {
  config: Config
  searcher: Searcher
  /** Accounts need both a database and a Google verifier; without them auth routes are not mounted. */
  db?: Db
  googleVerifier?: GoogleVerifier
  /** Online play; without it /ws is not mounted. */
  hub?: Hub
  logger?: boolean
}

interface BestMoveBody {
  fen: string
  level: number
}

export async function buildApp({ config, searcher, db, googleVerifier, hub, logger = false }: AppDeps): Promise<FastifyInstance> {
  const app = Fastify({ logger, trustProxy: config.trustProxy, bodyLimit: 4 * 1024 })

  // Never leak internals (SQL errors, stack hints) on 5xx; 4xx messages are ours or the validator's.
  app.setErrorHandler((err: FastifyError, req, reply) => {
    const status = err.statusCode && err.statusCode >= 400 ? err.statusCode : 500
    if (status >= 500) {
      req.log.error({ err }, 'request failed')
      return reply.code(status).send({ error: 'internal' })
    }
    return reply.code(status).send({ error: err.code ?? 'bad_request', message: err.message })
  })

  if (config.allowedOrigins.length > 0) await app.register(cors, { origin: config.allowedOrigins, credentials: true })
  await app.register(cookie)
  await app.register(rateLimit, { global: false })
  registerOriginCheck(app, config.allowedOrigins)

  registerGuestCookie(app, config.cookieSecure)

  if (db && googleVerifier && config.googleClientId) {
    registerAuth(app, { db, verifier: googleVerifier, googleClientId: config.googleClientId, secureCookies: config.cookieSecure })
  } else {
    app.get('/api/auth/config', async () => ({ googleClientId: null }))
    app.get('/api/auth/me', async () => ({ user: null }))
  }

  if (hub) await registerOnline(app, { hub, allowedOrigins: config.allowedOrigins, maxConnsPerIp: config.maxConnsPerIp })

  app.get('/api/health', async () => ({ status: 'ok' }))

  app.get('/api/levels', async () => LEVELS.map(({ id, label }) => ({ id, label })))

  app.post<{ Body: BestMoveBody }>(
    '/api/bestmove',
    {
      config: { rateLimit: { max: config.bestMoveRatePerMin, timeWindow: '1 minute' } },
      schema: {
        body: {
          type: 'object',
          required: ['fen', 'level'],
          additionalProperties: false,
          properties: {
            fen: { type: 'string', minLength: 10, maxLength: 120 },
            level: { type: 'integer', minimum: 1, maximum: LEVELS.length },
          },
        },
      },
    },
    async (req, reply) => {
      const { fen, level: levelId } = req.body
      const problem = fenProblem(fen)
      if (problem) return reply.code(400).send({ error: 'invalid_fen', message: problem })
      const { board, turn } = parseFen(fen)
      if (allLegalMoves(board, turn).length === 0) return reply.code(409).send({ error: 'game_over' })

      const level = getLevel(levelId)!
      const started = Date.now()
      try {
        const candidates = await searcher.search({
          fen: toUciFen(fen),
          limits: level.limits,
          multipv: level.multipv,
          // Generous cap over the nominal budget; depth-limited levels finish far sooner.
          timeoutMs: (level.limits.movetime ?? 3_000) + 2_000,
        })
        const chosen = pickMove(candidates, level)
        const ordered = chosen ? [chosen, ...candidates.filter((c) => c !== chosen)] : candidates
        const legal = firstLegal(fen, ordered)
        if (!legal) {
          req.log.error({ fen, candidates }, 'engine returned no legal move')
          return reply.code(502).send({ error: 'engine_error' })
        }
        return { move: legal.uci, level: levelId, ms: Date.now() - started }
      } catch (err) {
        if (err instanceof EngineBusyError) {
          return reply.code(503).header('Retry-After', '2').send({ error: 'busy' })
        }
        req.log.error({ err }, 'engine failure')
        return reply.code(503).send({ error: 'engine_unavailable' })
      }
    },
  )

  return app
}
