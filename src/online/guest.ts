import { createHash, randomBytes } from 'node:crypto'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { Identity } from './hub'

export const GUEST_COOKIE = 'gid'
const GUEST_RE = /^[A-Za-z0-9_-]{22}$/ // 16 random bytes, base64url
const ONE_YEAR_S = 365 * 24 * 60 * 60

/** Stable, human-friendly display name derived from the guest id, e.g. "Khách 4821". */
const guestName = (gid: string) => {
  const n = createHash('sha256').update(gid).digest().readUInt16BE(0) % 10_000
  return `Khách ${String(n).padStart(4, '0')}`
}

/**
 * Gives every browser an opaque guest id the first time it asks who it is (`/api/auth/me`), so
 * anonymous players can hold a seat in an online game and reconnect to it.
 */
export function registerGuestCookie(app: FastifyInstance, secure: boolean): void {
  app.addHook('onRequest', async (req, reply) => {
    if (req.method !== 'GET' || req.url.split('?')[0] !== '/api/auth/me') return
    if (GUEST_RE.test(req.cookies[GUEST_COOKIE] ?? '')) return
    reply.setCookie(GUEST_COOKIE, randomBytes(16).toString('base64url'), {
      path: '/', httpOnly: true, sameSite: 'lax', secure, maxAge: ONE_YEAR_S,
    })
  })
}

/** Who is making this request: the signed-in user, else the guest id, else nobody. */
export function identityFor(req: FastifyRequest): Identity | null {
  if (req.user) return { key: `u:${req.user.id}`, name: req.user.name, userId: req.user.id }
  const gid = req.cookies[GUEST_COOKIE]
  if (gid && GUEST_RE.test(gid)) return { key: `g:${gid}`, name: guestName(gid), userId: null }
  return null
}
