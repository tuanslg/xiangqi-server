import { spawn } from 'node:child_process'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { createInterface } from 'node:readline'

export interface SearchLimits {
  depth?: number
  movetime?: number
  nodes?: number
}

export interface Candidate {
  /** UCI move, e.g. "h2e2". */
  move: string
  /** Centipawns from the side to move's point of view; mates are mapped to +-MATE_SCORE. */
  score: number
  depth: number
}

export interface UciEngineOptions {
  binPath: string
  evalFile: string
  hashMb: number
  threads: number
}

export const MATE_SCORE = 30_000

export class EngineError extends Error {}

type Waiter = (line: string) => boolean | void

/** One Pikafish child process spoken to over UCI. One search at a time. */
export class UciEngine {
  private proc: ChildProcessWithoutNullStreams | null = null
  private waiter: Waiter | null = null
  private alive = false
  private readonly opts: UciEngineOptions

  constructor(opts: UciEngineOptions) {
    this.opts = opts
  }

  get isAlive(): boolean {
    return this.alive
  }

  async start(): Promise<void> {
    const proc = spawn(this.opts.binPath, [], { stdio: ['pipe', 'pipe', 'pipe'] })
    this.proc = proc
    this.alive = true
    proc.stderr.resume() // never let an unread pipe stall the engine
    proc.stdin.on('error', () => {}) // EPIPE after a crash is reported through 'exit'
    const spawned = new Promise<void>((resolve, reject) => {
      proc.once('spawn', resolve)
      proc.once('error', (err) => reject(new EngineError(`cannot start ${this.opts.binPath}: ${err.message}`)))
    })
    proc.on('exit', () => {
      this.alive = false
      this.proc = null
      this.waiter?.('') // wake any pending wait so it can fail fast
    })
    createInterface({ input: proc.stdout }).on('line', (line) => {
      if (this.waiter?.(line)) this.waiter = null
    })
    await spawned

    this.send('uci')
    await this.waitFor((l) => l === 'uciok', 10_000, 'uciok')
    this.send(`setoption name EvalFile value ${this.opts.evalFile}`)
    this.send(`setoption name Hash value ${this.opts.hashMb}`)
    this.send(`setoption name Threads value ${this.opts.threads}`)
    await this.ready()
  }

  /** Runs one search on `fen` (full UCI FEN). Resolves with candidates sorted best first. */
  async search(fen: string, limits: SearchLimits, multipv: number, timeoutMs: number): Promise<Candidate[]> {
    if (!this.alive) throw new EngineError('engine is not running')
    this.send('ucinewgame')
    this.send(`setoption name MultiPV value ${multipv}`)
    await this.ready()
    this.send(`position fen ${fen}`)

    const best = new Map<number, Candidate>()
    let bestmove: string | null = null
    const go = ['go']
    if (limits.depth !== undefined) go.push('depth', String(limits.depth))
    if (limits.movetime !== undefined) go.push('movetime', String(limits.movetime))
    if (limits.nodes !== undefined) go.push('nodes', String(limits.nodes))
    if (go.length === 1) go.push('depth', '10')

    const done = this.waitFor(
      (line) => {
        if (line.startsWith('info ')) {
          const parsed = parseInfo(line)
          const prev = parsed && best.get(parsed.index)
          if (parsed && (!prev || parsed.cand.depth >= prev.depth)) best.set(parsed.index, parsed.cand)
          return false
        }
        if (line.startsWith('bestmove ')) {
          bestmove = line.split(/\s+/)[1] ?? null
          return true
        }
        return false
      },
      timeoutMs,
      'bestmove',
      () => this.send('stop'),
    )
    done.catch(() => {}) // `send` below may throw first; the rejection is re-raised by `await done`
    this.send(go.join(' '))
    await done

    if (!bestmove || bestmove === '(none)') return []
    const list = [...best.entries()].sort((a, b) => a[0] - b[0]).map(([, c]) => c)
    // The engine's final answer is authoritative; make sure it leads the list.
    const idx = list.findIndex((c) => c.move === bestmove)
    if (idx > 0) list.unshift(...list.splice(idx, 1))
    else if (idx < 0) list.unshift({ move: bestmove, score: list[0]?.score ?? 0, depth: list[0]?.depth ?? 0 })
    return list
  }

  stop(): void {
    const proc = this.proc
    if (!proc) return
    try {
      proc.stdin.write('quit\n')
    } catch {
      // already dead
    }
    setTimeout(() => proc.kill('SIGKILL'), 500).unref()
  }

  private send(cmd: string): void {
    if (!this.proc || !this.alive) throw new EngineError('engine is not running')
    this.proc.stdin.write(cmd + '\n')
  }

  private async ready(): Promise<void> {
    this.send('isready')
    await this.waitFor((l) => l === 'readyok', 10_000, 'readyok')
  }

  /**
   * Resolves once `match` returns true for a line. On timeout it calls `onSoftTimeout`
   * (e.g. `stop`) and allows a short grace period before killing the engine.
   */
  private waitFor(match: Waiter, timeoutMs: number, what: string, onSoftTimeout?: () => void): Promise<void> {
    return new Promise((resolve, reject) => {
      let hard: NodeJS.Timeout | undefined
      const finish = (err?: Error) => {
        clearTimeout(soft)
        clearTimeout(hard)
        this.waiter = null
        if (err) reject(err)
        else resolve()
      }
      const soft = setTimeout(() => {
        try {
          onSoftTimeout?.()
        } catch {
          // fall through to the hard timeout
        }
        hard = setTimeout(() => {
          this.stop()
          finish(new EngineError(`timed out waiting for ${what}`))
        }, 1_000)
      }, timeoutMs)
      this.waiter = (line) => {
        if (!this.alive) {
          finish(new EngineError('engine exited unexpectedly'))
          return true
        }
        if (match(line)) {
          finish()
          return true
        }
        return false
      }
    })
  }
}

const INFO_RE = /\bdepth (\d+)\b.*?\bmultipv (\d+)\b.*?\bscore (cp|mate) (-?\d+)\b.*?\bpv ([a-i][0-9][a-i][0-9])/

export function parseInfo(line: string): { index: number; cand: Candidate } | null {
  const m = INFO_RE.exec(line)
  if (!m) return null
  const raw = Number(m[4])
  const score = m[3] === 'cp' ? raw : raw > 0 ? MATE_SCORE - raw : -MATE_SCORE - raw
  return { index: Number(m[2]), cand: { move: m[5], score, depth: Number(m[1]) } }
}
