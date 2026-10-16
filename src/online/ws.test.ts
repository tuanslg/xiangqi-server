import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import WebSocket from 'ws'
import type { RoomSnapshot, ServerMessage } from '@xiangqi/shared'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../app'
import type { Config } from '../config'
import { Hub } from './hub'

const config: Config = {
  port: 0, host: '127.0.0.1', allowedOrigins: ['http://app.example'], pikafishPath: '', pikafishEval: '',
  poolSize: 1, maxQueue: 1, hashMb: 1, threads: 1, trustProxy: false, bestMoveRatePerMin: 1000,
  databaseUrl: null, googleClientId: null, cookieSecure: false, maxConnsPerIp: 3,
}

let app: FastifyInstance
let hub: Hub
let base: string

beforeAll(async () => {
  hub = new Hub()
  app = await buildApp({ config, searcher: { search: async () => [] }, hub })
  await app.listen({ port: 0, host: '127.0.0.1' })
  const addr = app.server.address()
  base = `127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`
})
afterAll(async () => {
  hub.close()
  await app.close()
})

/** Asks /api/auth/me for a guest cookie, like the real client does on load. */
async function guestCookie(): Promise<string> {
  const res = await fetch(`http://${base}/api/auth/me`)
  const set = res.headers.getSetCookie().find((c) => c.startsWith('gid='))!
  return set.split(';')[0]
}

class Client {
  msgs: ServerMessage[] = []
  private waiters: (() => void)[] = []
  readonly ws: WebSocket
  constructor(cookie: string, origin: string | undefined = 'http://app.example') {
    this.ws = new WebSocket(`ws://${base}/ws`, { headers: { cookie, ...(origin ? { origin } : {}) } })
    this.ws.on('message', (d) => {
      this.msgs.push(JSON.parse(d.toString()))
      this.waiters.splice(0).forEach((w) => w())
    })
  }
  send(m: unknown) {
    this.ws.send(JSON.stringify(m))
  }
  async until<T extends ServerMessage>(pred: (m: ServerMessage) => m is T, from = 0): Promise<T> {
    for (;;) {
      const hit = this.msgs.slice(from).find(pred)
      if (hit) return hit
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(() => reject(new Error(`timeout; got ${JSON.stringify(this.msgs.slice(from))}`)), 2000)
        this.waiters.push(() => {
          clearTimeout(t)
          resolve()
        })
      })
    }
  }
  room = async (pred: (r: RoomSnapshot) => boolean = () => true, from = 0) =>
    (await this.until((m): m is Extract<ServerMessage, { t: 'room' }> => m.t === 'room' && pred(m.room), from)).room
  close() {
    this.ws.close()
  }
}

/** Resolves with the HTTP status if the upgrade is refused, or 'open'. */
const attempt = (cookie: string, origin?: string) =>
  new Promise<number | 'open'>((resolve) => {
    const ws = new WebSocket(`ws://${base}/ws`, { headers: { cookie, ...(origin ? { origin } : {}) } })
    ws.on('open', () => {
      ws.close()
      resolve('open')
    })
    ws.on('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0))
    ws.on('error', () => {})
  })

describe('websocket gateway', () => {
  it('hands out a guest cookie once and reuses it', async () => {
    const first = await fetch(`http://${base}/api/auth/me`)
    const cookie = first.headers.getSetCookie().find((c) => c.startsWith('gid='))!
    expect(cookie).toMatch(/HttpOnly/i)
    expect(cookie).toMatch(/SameSite=Lax/i)
    const again = await fetch(`http://${base}/api/auth/me`, { headers: { cookie: cookie.split(';')[0] } })
    expect(again.headers.getSetCookie().find((c) => c.startsWith('gid='))).toBeUndefined()
  })

  it('refuses connections without identity or from foreign origins, accepts good ones', async () => {
    const cookie = await guestCookie()
    expect(await attempt('')).toBe(401)
    expect(await attempt('gid=short')).toBe(401)
    expect(await attempt(cookie, 'https://evil.example')).toBe(403)
    expect(await attempt(cookie, 'http://app.example')).toBe('open')
    expect(await attempt(cookie, `http://${base}`)).toBe('open') // same host
  })

  it('plays a game across two real sockets', async () => {
    const a = new Client(await guestCookie())
    const b = new Client(await guestCookie())
    const welcomeA = await a.until((m): m is Extract<ServerMessage, { t: 'welcome' }> => m.t === 'welcome')
    expect(welcomeA.name).toMatch(/^Khách \d{4}$/)
    expect(welcomeA.signedIn).toBe(false)
    await b.until((m): m is Extract<ServerMessage, { t: 'welcome' }> => m.t === 'welcome')

    a.send({ t: 'create', color: 'red', tc: '3+2' })
    const waiting = await a.room((r) => r.status === 'waiting')
    b.send({ t: 'join', code: waiting.code })
    const startedA = await a.room((r) => r.status === 'playing')
    const startedB = await b.room((r) => r.status === 'playing')
    expect(startedA.you).toBe('red')
    expect(startedB.you).toBe('black')

    a.send({ t: 'move', from: { row: 7, col: 1 }, to: { row: 7, col: 4 } })
    const seen = await b.room((r) => r.moveCount === 1)
    expect(seen.turn).toBe('black')

    b.send({ t: 'resign' })
    const done = await a.room((r) => r.status === 'finished')
    expect(done.result).toEqual({ winner: 'red', reason: 'resign' })
    a.close()
    b.close()
  })

  it('answers bad input with errors and drops abusers', async () => {
    const c = new Client(await guestCookie())
    await c.until((m): m is Extract<ServerMessage, { t: 'welcome' }> => m.t === 'welcome')
    c.ws.send('not json')
    c.send({ t: 'move', from: { row: 99, col: 0 }, to: { row: 0, col: 0 } })
    c.send({ t: 'nope' })
    await c.until((m): m is Extract<ServerMessage, { t: 'error' }> => m.t === 'error' && m.code === 'bad_message')
    expect(c.msgs.filter((m) => m.t === 'error')).toHaveLength(3)

    const closed = new Promise<number>((resolve) => c.ws.on('close', (code) => resolve(code)))
    for (let i = 0; i < 12; i++) c.send({ t: 'nope' })
    expect(await closed).toBe(1008)
  })

  it('closes connections that send oversized frames', async () => {
    const c = new Client(await guestCookie())
    await c.until((m): m is Extract<ServerMessage, { t: 'welcome' }> => m.t === 'welcome')
    const closed = new Promise<number>((resolve) => c.ws.on('close', (code) => resolve(code)))
    c.ws.send('x'.repeat(5000))
    expect(await closed).toBe(1009)
  })

  it('limits concurrent connections per IP', async () => {
    // distinct guests: reusing one cookie would just replace the older sockets
    const open = await Promise.all(Array.from({ length: 3 }, async () => new Client(await guestCookie())))
    await Promise.all(open.map((c) => c.until((m): m is Extract<ServerMessage, { t: 'welcome' }> => m.t === 'welcome')))
    expect(await attempt(await guestCookie(), 'http://app.example')).toBe(429)
    open.forEach((c) => c.close())
  })

  it('restores the game when the same guest reconnects', async () => {
    const cookieA = await guestCookie()
    const a = new Client(cookieA)
    const b = new Client(await guestCookie())
    await a.until((m): m is Extract<ServerMessage, { t: 'welcome' }> => m.t === 'welcome')
    await b.until((m): m is Extract<ServerMessage, { t: 'welcome' }> => m.t === 'welcome')
    a.send({ t: 'create', color: 'black', tc: '30+0' })
    const w = await a.room((r) => r.status === 'waiting')
    b.send({ t: 'join', code: w.code })
    await a.room((r) => r.status === 'playing')

    a.close()
    await b.room((r) => r.black?.online === false)
    const a2 = new Client(cookieA)
    const welcome = await a2.until((m): m is Extract<ServerMessage, { t: 'welcome' }> => m.t === 'welcome')
    expect(welcome.room).toMatchObject({ status: 'playing', you: 'black', code: w.code })
    a2.close()
    b.close()
  })
})
