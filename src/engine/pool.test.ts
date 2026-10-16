import { describe, expect, it } from 'vitest'
import { EngineBusyError, EnginePool } from './pool'
import type { SearchRequest } from './pool'
import { EngineError, UciEngine } from './uciEngine'
import type { Candidate } from './uciEngine'

const req: SearchRequest = { fen: 'x', limits: { depth: 1 }, multipv: 1, timeoutMs: 1000 }
const move: Candidate = { move: 'h2e2', score: 0, depth: 1 }

class FakeEngine extends UciEngine {
  static created = 0
  static behaviour: (n: number) => Promise<Candidate[]> = async () => [move]
  up = false
  readonly id = ++FakeEngine.created
  constructor() {
    super({ binPath: '', evalFile: '', hashMb: 1, threads: 1 })
  }
  override get isAlive() {
    return this.up
  }
  override async start() {
    this.up = true
  }
  override async search() {
    return FakeEngine.behaviour(this.id)
  }
  override stop() {
    this.up = false
  }
}

const deferred = () => {
  let resolve!: (c: Candidate[]) => void
  const promise = new Promise<Candidate[]>((r) => (resolve = r))
  return { promise, resolve }
}

describe('EnginePool', () => {
  it('serves requests and reuses a healthy engine', async () => {
    FakeEngine.created = 0
    FakeEngine.behaviour = async () => [move]
    const pool = new EnginePool(() => new FakeEngine(), 1, 4)
    await pool.search(req)
    await pool.search(req)
    expect(FakeEngine.created).toBe(1)
  })

  it('runs at most `size` searches at once and queues the rest in order', async () => {
    FakeEngine.created = 0
    const gates = [deferred(), deferred(), deferred()]
    let started = 0
    FakeEngine.behaviour = () => gates[started++].promise
    const pool = new EnginePool(() => new FakeEngine(), 2, 4)
    const done = gates.map(() => pool.search(req))
    await new Promise((r) => setTimeout(r, 10))
    expect(started).toBe(2) // third is queued
    gates[0].resolve([move])
    await done[0]
    await new Promise((r) => setTimeout(r, 10))
    expect(started).toBe(3)
    gates[1].resolve([move])
    gates[2].resolve([move])
    await Promise.all(done)
  })

  it('rejects with EngineBusyError when the queue is full', async () => {
    const gate = deferred()
    FakeEngine.behaviour = () => gate.promise
    const pool = new EnginePool(() => new FakeEngine(), 1, 1)
    const running = pool.search(req) // takes the slot
    const queued = pool.search(req) // fills the queue
    await expect(pool.search(req)).rejects.toBeInstanceOf(EngineBusyError)
    gate.resolve([move])
    await Promise.all([running, queued])
  })

  it('replaces an engine that failed and keeps serving', async () => {
    FakeEngine.created = 0
    let calls = 0
    FakeEngine.behaviour = async () => {
      if (calls++ === 0) throw new EngineError('boom')
      return [move]
    }
    const pool = new EnginePool(() => new FakeEngine(), 1, 4)
    await expect(pool.search(req)).rejects.toThrow('boom')
    await expect(pool.search(req)).resolves.toEqual([move])
    expect(FakeEngine.created).toBe(2)
  })

  it('rejects queued work on close', async () => {
    const gate = deferred()
    FakeEngine.behaviour = () => gate.promise
    const pool = new EnginePool(() => new FakeEngine(), 1, 4)
    const running = pool.search(req)
    const queued = pool.search(req)
    pool.close()
    await expect(queued).rejects.toThrow('closed')
    await expect(pool.search(req)).rejects.toThrow('closed')
    gate.resolve([move])
    await running
  })
})
