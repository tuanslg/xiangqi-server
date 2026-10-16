import { randomBytes, timingSafeEqual } from 'node:crypto'
import type { FastifyInstance, FastifyReply } from 'fastify'
import type { Db } from '../db/pool'
import type { GoogleVerifier } from './google'
import { SESSION_COOKIE, SESSION_TTL_MS, createSession, deleteSession, findSessionUser } from './sessions'
import type { User } from './users'
import { upsertGoogleUser } from './users'

declare module 'fastify' {
  interface FastifyRequest {
    /** The signed-in user, or null for guests. Always null when accounts are disabled. */
    user: User | null
  }
}

const NONCE_COOKIE = 'gnonce'
const NONCE_TTL_S = 10 * 60

export interface AuthDeps {
  db: Db
  verifier: GoogleVerifier
  googleClientId: string
  secureCookies: boolean
}

const safeEqual = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b))

/** Registers /api/auth/* and fills `req.user` from the session cookie. */
export function registerAuth(app: FastifyInstance, deps: AuthDeps): void {
  const { db, verifier, googleClientId, secureCookies } = deps
  const cookieBase = { path: '/', httpOnly: true, sameSite: 'lax', secure: secureCookies } as const

  app.addHook('onRequest', async (req) => {
    const token = req.cookies[SESSION_COOKIE]
    req.user = token ? await findSessionUser(db, token) : null
  })

  const noStore = (reply: FastifyReply) => reply.header('Cache-Control', 'no-store')

  app.get('/api/auth/config', async () => ({ googleClientId }))

  // The nonce is bound to the browser by an httpOnly cookie and to Google's token by the `nonce`
  // claim, so a stolen ID token is useless without the cookie.
  app.get('/api/auth/nonce', async (_req, reply) => {
    const nonce = randomBytes(24).toString('base64url')
    reply.setCookie(NONCE_COOKIE, nonce, { ...cookieBase, maxAge: NONCE_TTL_S })
    return noStore(reply).send({ nonce })
  })

  app.post<{ Body: { credential: string } }>(
    '/api/auth/google',
    {
      config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
      schema: {
        body: {
          type: 'object',
          required: ['credential'],
          properties: { credential: { type: 'string', minLength: 20, maxLength: 4096 } },
        },
      },
    },
    async (req, reply) => {
      const expected = req.cookies[NONCE_COOKIE]
      reply.clearCookie(NONCE_COOKIE, cookieBase) // single use, even if verification fails
      let identity
      try {
        identity = await verifier(req.body.credential)
      } catch (err) {
        req.log.info({ err }, 'google token rejected')
        return reply.code(401).send({ error: 'invalid_token' })
      }
      if (!expected || !identity.nonce || !safeEqual(expected, identity.nonce))
        return reply.code(401).send({ error: 'invalid_nonce' })

      const user = await upsertGoogleUser(db, identity)
      const { token } = await createSession(db, user.id)
      reply.setCookie(SESSION_COOKIE, token, { ...cookieBase, maxAge: SESSION_TTL_MS / 1000 })
      return noStore(reply).send({ user })
    },
  )

  app.get('/api/auth/me', async (req, reply) => noStore(reply).send({ user: req.user }))

  app.post('/api/auth/logout', async (req, reply) => {
    await deleteSession(db, req.cookies[SESSION_COOKIE])
    reply.clearCookie(SESSION_COOKIE, cookieBase)
    return { ok: true }
  })
}
