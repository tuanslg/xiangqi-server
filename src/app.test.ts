import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { START_FEN } from '@xiangqi/shared'
import type { FastifyInstance } from 'fastify'
import { buildApp } from './app'
import type { Config } from './config'
import { EngineBusyError } from './engine/pool'
import type { SearchRequest, Searcher } from './engine/pool'
import { EngineError } from './engine/uciEngine'
import type { Candidate } from './engine/uciEngine'

const config: Config = {
  port: 0, host: '127.0.0.1', allowedOrigins: [], pikafishPath: '', pikafishEval: '',
  poolSize: 1, maxQueue: 1, hashMb: 1, threads: 1, trustProxy: false, bestMoveRatePerMin: 1000, databaseUrl: null, googleClientId: null, cookieSecure: false, maxConnsPerIp: 20,
}

let handler: (r: SearchRequest) => Promise<Candidate[]>
const searcher: Searcher = { search: (r) => handler(r) }
let app: FastifyInstance

beforeAll(async () => {
  app = await buildApp({ config, searcher })
})
afterAll(() => app.close())

const post = (payload: unknown) => app.inject({ method: 'POST', url: '/api/bestmove', payload: payload as object })

describe('POST /api/bestmove', () => {
  it('returns the engine move for a valid request and passes a full UCI FEN', async () => {
    let seen: SearchRequest | undefined
    handler = async (r) => {
      seen = r
      return [{ move: 'h2e2', score: 30, depth: 5 }]
    }
    const res = await post({ fen: START_FEN, level: 4 })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ move: 'h2e2', level: 4 })
    expect(seen?.fen).toBe(`${START_FEN} - - 0 1`)
  })

  it('rejects bad input without calling the engine', async () => {
    handler = async () => {
      throw new Error('engine must not be called')
    }
    expect((await post({ fen: 'garbage garbage', level: 1 })).statusCode).toBe(400)
    expect((await post({ fen: START_FEN, level: 9 })).statusCode).toBe(400)
    expect((await post({ fen: START_FEN })).statusCode).toBe(400)
    const bad = await post({ fen: 'rnba1abnr/9/1c5c1/p1p1p1p1p/9/9/P1P1P1P1P/1C5C1/9/RNBAKABNR w', level: 1 })
    expect(bad.statusCode).toBe(400)
    expect(bad.json().error).toBe('invalid_fen')
  })

  it('answers 409 when the side to move has no legal moves', async () => {
    handler = async () => {
      throw new Error('engine must not be called')
    }
    // Black king on e10 mated by two red rooks (ladder mate).
    const res = await post({ fen: 'R3k4/8R/9/9/9/9/9/9/9/3K5 b', level: 1 })
    expect(res.statusCode).toBe(409)
    expect(res.json().error).toBe('game_over')
  })

  it('never returns an illegal engine move', async () => {
    handler = async () => [{ move: 'a0a5', score: 0, depth: 1 }]
    const res = await post({ fen: START_FEN, level: 4 })
    expect(res.statusCode).toBe(502)
  })

  it('maps pool saturation to 503 + Retry-After and engine failure to 503', async () => {
    handler = async () => {
      throw new EngineBusyError('full')
    }
    const busy = await post({ fen: START_FEN, level: 1 })
    expect(busy.statusCode).toBe(503)
    expect(busy.headers['retry-after']).toBe('2')
    handler = async () => {
      throw new EngineError('dead')
    }
    expect((await post({ fen: START_FEN, level: 1 })).statusCode).toBe(503)
  })
})

describe('misc routes', () => {
  it('serves health and level list', async () => {
    expect((await app.inject('/api/health')).json()).toEqual({ status: 'ok' })
    const levels = (await app.inject('/api/levels')).json()
    expect(levels.map((l: { id: number }) => l.id)).toEqual([1, 2, 3, 4])
  })
})

describe('separate frontend origin (CORS)', () => {
  const APP = 'https://app.example.com'
  let split: FastifyInstance
  beforeAll(async () => {
    split = await buildApp({ config: { ...config, allowedOrigins: [APP] }, searcher })
  })
  afterAll(() => split.close())

  it('answers the preflight for the allowed frontend with credentials', async () => {
    const res = await split.inject({
      method: 'OPTIONS', url: '/api/bestmove',
      headers: { origin: APP, 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type' },
    })
    expect(res.statusCode).toBe(204)
    expect(res.headers['access-control-allow-origin']).toBe(APP)
    expect(res.headers['access-control-allow-credentials']).toBe('true')
    expect(res.headers['access-control-allow-headers']).toMatch(/content-type/i)
  })

  it('lets the allowed frontend call the API and read the guest cookie response', async () => {
    handler = async () => [{ move: 'h2e2', score: 0, depth: 1 }]
    const res = await split.inject({
      method: 'POST', url: '/api/bestmove', headers: { origin: APP }, payload: { fen: START_FEN, level: 1 },
    })
    expect(res.statusCode).toBe(200)
    expect(res.headers['access-control-allow-origin']).toBe(APP)
    const me = await split.inject({ url: '/api/auth/me', headers: { origin: APP } })
    expect(me.headers['access-control-allow-credentials']).toBe('true')
    expect(me.headers['set-cookie']).toMatch(/gid=.*SameSite=Lax/)
  })

  it('gives other origins no CORS grant, and refuses their writes', async () => {
    const pre = await split.inject({
      method: 'OPTIONS', url: '/api/bestmove',
      headers: { origin: 'https://evil.example', 'access-control-request-method': 'POST' },
    })
    expect(pre.headers['access-control-allow-origin']).toBeUndefined()
    const write = await split.inject({
      method: 'POST', url: '/api/bestmove', headers: { origin: 'https://evil.example' }, payload: { fen: START_FEN, level: 1 },
    })
    expect(write.statusCode).toBe(403)
  })
})
