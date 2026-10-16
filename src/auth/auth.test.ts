import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance, LightMyRequestResponse } from 'fastify'
import { buildApp } from '../app'
import type { Config } from '../config'
import { migrate } from '../db/migrate'
import { createPool } from '../db/pool'
import type { Db } from '../db/pool'
import type { GoogleVerifier, VerifiedGoogleToken } from './google'

// Needs a throwaway Postgres: TEST_DATABASE_URL=postgres://.../xiangqi_test npm test
const url = process.env.TEST_DATABASE_URL
if (url && !/_test(\?|$)/.test(url)) throw new Error('TEST_DATABASE_URL must point at a database whose name ends in _test (it gets wiped)')

const config: Config = {
  port: 0, host: '127.0.0.1', allowedOrigins: ['http://app.example'], pikafishPath: '', pikafishEval: '',
  poolSize: 1, maxQueue: 1, hashMb: 1, threads: 1, trustProxy: false, bestMoveRatePerMin: 1000,
  databaseUrl: url ?? null, googleClientId: 'client-id.apps.googleusercontent.com', cookieSecure: false, maxConnsPerIp: 20,
}

describe.skipIf(!url)('auth (Postgres)', () => {
  let db: Db
  let app: FastifyInstance
  let identity: Partial<VerifiedGoogleToken> = {}
  let verifyError: Error | null = null

  const verifier: GoogleVerifier = async (credential) => {
    if (verifyError) throw verifyError
    return { sub: 'google-sub-1', email: 'a@example.com', name: 'An Nguyen', picture: null, nonce: credential.slice(-4), ...identity }
  }

  beforeAll(async () => {
    db = createPool(url!)
    await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public')
    await migrate(db)
    app = await buildApp({ config, searcher: { search: async () => [] }, db, googleVerifier: verifier })
  })
  afterAll(async () => {
    await app.close()
    await db.end()
  })
  beforeEach(async () => {
    identity = {}
    verifyError = null
    await db.query('TRUNCATE users CASCADE')
  })

  const cookie = (res: LightMyRequestResponse, name: string) => res.cookies.find((c) => c.name === name)
  const header = (...pairs: [string, string | undefined][]) =>
    pairs.filter(([, v]) => v !== undefined).map(([k, v]) => `${k}=${v}`).join('; ')

  it('migrations are idempotent', async () => {
    expect(await migrate(db)).toEqual([])
  })

  it('exposes the client id', async () => {
    expect((await app.inject('/api/auth/config')).json()).toEqual({ googleClientId: config.googleClientId })
  })

  it('logs in, remembers the user, and logs out', async () => {
    // fake verifier echoes the last 4 chars as nonce, so make the real nonce match that
    const n = await app.inject('/api/auth/nonce')
    const nonce = n.json().nonce as string
    identity.nonce = nonce
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/google',
      headers: { cookie: header(['gnonce', cookie(n, 'gnonce')!.value]) },
      payload: { credential: 'c'.repeat(40) },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().user).toMatchObject({ name: 'An Nguyen', picture: null })
    expect(res.json().user.email).toBeUndefined()

    const sid = cookie(res, 'sid')!
    expect(sid.httpOnly).toBe(true)
    expect(sid.sameSite).toBe('Lax')
    expect(cookie(res, 'gnonce')?.value).toBe('') // nonce cookie consumed

    // the DB must not contain the raw token
    const stored = await db.query('SELECT token_hash FROM sessions')
    expect(stored.rowCount).toBe(1)
    expect(Buffer.from(stored.rows[0].token_hash).toString('base64url')).not.toBe(sid.value)

    const me = await app.inject({ url: '/api/auth/me', headers: { cookie: header(['sid', sid.value]) } })
    expect(me.json().user.name).toBe('An Nguyen')
    expect(me.headers['cache-control']).toBe('no-store')

    const out = await app.inject({ method: 'POST', url: '/api/auth/logout', headers: { cookie: header(['sid', sid.value]) } })
    expect(out.statusCode).toBe(200)
    expect((await db.query('SELECT 1 FROM sessions')).rowCount).toBe(0)
    const after = await app.inject({ url: '/api/auth/me', headers: { cookie: header(['sid', sid.value]) } })
    expect(after.json().user).toBeNull()
  })

  it('treats anonymous, forged and malformed cookies as guests', async () => {
    expect((await app.inject('/api/auth/me')).json().user).toBeNull()
    for (const sid of ['nonsense', 'A'.repeat(43), "x'; DROP TABLE users;--"]) {
      const r = await app.inject({ url: '/api/auth/me', headers: { cookie: header(['sid', encodeURIComponent(sid)]) } })
      expect(r.statusCode).toBe(200)
      expect(r.json().user).toBeNull()
    }
  })

  it('rejects an expired session', async () => {
    const n = await app.inject('/api/auth/nonce')
    identity.nonce = n.json().nonce
    const res = await app.inject({
      method: 'POST', url: '/api/auth/google',
      headers: { cookie: header(['gnonce', cookie(n, 'gnonce')!.value]) },
      payload: { credential: 'c'.repeat(40) },
    })
    const sid = cookie(res, 'sid')!.value
    await db.query("UPDATE sessions SET expires_at = now() - interval '1 second'")
    const me = await app.inject({ url: '/api/auth/me', headers: { cookie: header(['sid', sid]) } })
    expect(me.json().user).toBeNull()
  })

  it('rejects login without the nonce cookie, with a different nonce, or when Google rejects the token', async () => {
    const n = await app.inject('/api/auth/nonce')
    const good = n.json().nonce as string

    identity.nonce = good
    const noCookie = await app.inject({ method: 'POST', url: '/api/auth/google', payload: { credential: 'c'.repeat(40) } })
    expect(noCookie.statusCode).toBe(401)

    identity.nonce = 'attacker-chosen-nonce'
    const mismatch = await app.inject({
      method: 'POST', url: '/api/auth/google',
      headers: { cookie: header(['gnonce', cookie(n, 'gnonce')!.value]) },
      payload: { credential: 'c'.repeat(40) },
    })
    expect(mismatch.statusCode).toBe(401)

    identity.nonce = good
    verifyError = new Error('Wrong recipient, payload audience != requiredAudience')
    const bad = await app.inject({
      method: 'POST', url: '/api/auth/google',
      headers: { cookie: header(['gnonce', cookie(n, 'gnonce')!.value]) },
      payload: { credential: 'c'.repeat(40) },
    })
    expect(bad.statusCode).toBe(401)
    expect(bad.json().error).toBe('invalid_token')
    expect((await db.query('SELECT 1 FROM sessions')).rowCount).toBe(0)
  })

  it('does not accept a token whose nonce claim is missing', async () => {
    const n = await app.inject('/api/auth/nonce')
    identity.nonce = null
    const res = await app.inject({
      method: 'POST', url: '/api/auth/google',
      headers: { cookie: header(['gnonce', cookie(n, 'gnonce')!.value]) },
      payload: { credential: 'c'.repeat(40) },
    })
    expect(res.statusCode).toBe(401)
  })

  it('upserts by Google subject: same account twice is one user, with refreshed profile', async () => {
    for (const name of ['Old Name', 'New Name']) {
      const n = await app.inject('/api/auth/nonce')
      identity = { nonce: n.json().nonce, name }
      const r = await app.inject({
        method: 'POST', url: '/api/auth/google',
        headers: { cookie: header(['gnonce', cookie(n, 'gnonce')!.value]) },
        payload: { credential: 'c'.repeat(40) },
      })
      expect(r.statusCode).toBe(200)
    }
    const users = await db.query('SELECT name FROM users')
    expect(users.rows).toEqual([{ name: 'New Name' }])
  })

  it('rejects malformed login bodies', async () => {
    expect((await app.inject({ method: 'POST', url: '/api/auth/google', payload: {} })).statusCode).toBe(400)
    expect((await app.inject({ method: 'POST', url: '/api/auth/google', payload: { credential: 'short' } })).statusCode).toBe(400)
  })

  it('blocks cross-site writes by Origin but allows listed and same-host origins', async () => {
    const evil = await app.inject({ method: 'POST', url: '/api/auth/logout', headers: { origin: 'https://evil.example' } })
    expect(evil.statusCode).toBe(403)
    const listed = await app.inject({ method: 'POST', url: '/api/auth/logout', headers: { origin: 'http://app.example' } })
    expect(listed.statusCode).toBe(200)
    const same = await app.inject({ method: 'POST', url: '/api/auth/logout', headers: { origin: 'http://game.test', host: 'game.test' } })
    expect(same.statusCode).toBe(200)
    const junk = await app.inject({ method: 'POST', url: '/api/auth/logout', headers: { origin: 'not a url' } })
    expect(junk.statusCode).toBe(403)
  })

  it('never leaks internals on server errors', async () => {
    await db.query('ALTER TABLE users RENAME TO users_gone')
    try {
      const n = await app.inject('/api/auth/nonce')
      identity.nonce = n.json().nonce
      const res = await app.inject({
        method: 'POST', url: '/api/auth/google',
        headers: { cookie: header(['gnonce', cookie(n, 'gnonce')!.value]) },
        payload: { credential: 'c'.repeat(40) },
      })
      expect(res.statusCode).toBe(500)
      expect(res.json()).toEqual({ error: 'internal' })
    } finally {
      await db.query('ALTER TABLE users_gone RENAME TO users')
    }
  })
})
