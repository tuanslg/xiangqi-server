import type { Candidate, SearchLimits, UciEngineOptions } from './uciEngine'
import { EngineError, UciEngine } from './uciEngine'

export class EngineBusyError extends Error {}

export interface SearchRequest {
  fen: string
  limits: SearchLimits
  multipv: number
  timeoutMs: number
}

export interface Searcher {
  search(req: SearchRequest): Promise<Candidate[]>
}

interface Job {
  req: SearchRequest
  resolve: (c: Candidate[]) => void
  reject: (e: Error) => void
}

interface Slot {
  engine: UciEngine | null
  busy: boolean
}

type EngineFactory = () => UciEngine

/** Fixed-size pool of engine processes with a bounded FIFO queue. */
export class EnginePool implements Searcher {
  private readonly slots: Slot[]
  private readonly queue: Job[] = []
  private closed = false
  private readonly factory: EngineFactory
  private readonly maxQueue: number

  constructor(factory: EngineFactory, size: number, maxQueue: number) {
    this.factory = factory
    this.maxQueue = maxQueue
    this.slots = Array.from({ length: size }, () => ({ engine: null, busy: false }))
  }

  static fromOptions(opts: UciEngineOptions, size: number, maxQueue: number): EnginePool {
    return new EnginePool(() => new UciEngine(opts), size, maxQueue)
  }

  /** Starts one engine eagerly so a bad binary path fails at boot, not on the first request. */
  async warmUp(): Promise<void> {
    const slot = this.slots[0]
    slot.engine = await this.boot()
  }

  search(req: SearchRequest): Promise<Candidate[]> {
    if (this.closed) return Promise.reject(new EngineError('pool is closed'))
    return new Promise((resolve, reject) => {
      const idle = this.slots.some((s) => !s.busy)
      if (!idle && this.queue.length >= this.maxQueue) {
        reject(new EngineBusyError('engine queue is full'))
        return
      }
      this.queue.push({ req, resolve, reject })
      this.pump()
    })
  }

  close(): void {
    this.closed = true
    for (const job of this.queue.splice(0)) job.reject(new EngineError('pool is closed'))
    for (const s of this.slots) s.engine?.stop()
  }

  private async boot(): Promise<UciEngine> {
    const engine = this.factory()
    try {
      await engine.start()
    } catch (err) {
      engine.stop()
      throw err
    }
    return engine
  }

  private pump(): void {
    for (const slot of this.slots) {
      if (slot.busy) continue
      const job = this.queue.shift()
      if (!job) return
      slot.busy = true
      void this.run(slot, job)
    }
  }

  private async run(slot: Slot, job: Job): Promise<void> {
    try {
      if (!slot.engine?.isAlive) slot.engine = await this.boot()
      job.resolve(await slot.engine.search(job.req.fen, job.req.limits, job.req.multipv, job.req.timeoutMs))
    } catch (err) {
      // Drop the engine: its state is unknown after a failure; the next job boots a fresh one.
      slot.engine?.stop()
      slot.engine = null
      job.reject(err instanceof Error ? err : new EngineError(String(err)))
    } finally {
      slot.busy = false
      if (!this.closed) this.pump()
    }
  }
}
