import { existsSync } from 'node:fs'
import { afterAll, describe, expect, it } from 'vitest'
import { START_FEN, allLegalMoves, parseFen, toUciFen, uciToMove } from '@xiangqi/shared'
import { loadConfig } from '../config'
import { EnginePool } from './pool'

const config = loadConfig()
const installed = existsSync(config.pikafishPath) && existsSync(config.pikafishEval)

// Runs against the real binary; install it with `npm run engine:fetch -w @xiangqi/server`.
describe.skipIf(!installed)('Pikafish (real engine)', () => {
  const pool = EnginePool.fromOptions(
    { binPath: config.pikafishPath, evalFile: config.pikafishEval, hashMb: 16, threads: 1 },
    2,
    8,
  )
  afterAll(() => pool.close())

  it('plays a legal opening move and ranks MultiPV candidates', async () => {
    const out = await pool.search({ fen: toUciFen(START_FEN), limits: { depth: 6 }, multipv: 4, timeoutMs: 10_000 })
    expect(out.length).toBeGreaterThanOrEqual(2)
    expect(new Set(out.map((c) => c.move)).size).toBe(out.length)
    const { board, turn } = parseFen(START_FEN)
    const legal = allLegalMoves(board, turn)
    for (const c of out) {
      const m = uciToMove(c.move)!
      expect(legal.some((l) => l.from.row === m.from.row && l.from.col === m.from.col && l.to.row === m.to.row && l.to.col === m.to.col)).toBe(true)
    }
  })

  it('sees a forced mate (two-rook ladder)', async () => {
    const fen = toUciFen('4k4/9/R8/9/9/9/9/9/8R/3K5 w')
    const [best] = await pool.search({ fen, limits: { depth: 8 }, multipv: 1, timeoutMs: 10_000 })
    expect(best.score).toBeGreaterThan(20_000)
  })

  it('stops at the movetime budget', async () => {
    const t0 = Date.now()
    await pool.search({ fen: toUciFen(START_FEN), limits: { movetime: 300 }, multipv: 1, timeoutMs: 5_000 })
    expect(Date.now() - t0).toBeLessThan(1_500)
  })

  it('handles concurrent searches on separate engines', async () => {
    const runs = await Promise.all(
      Array.from({ length: 4 }, () => pool.search({ fen: toUciFen(START_FEN), limits: { depth: 4 }, multipv: 1, timeoutMs: 10_000 })),
    )
    expect(runs.every((r) => r.length === 1)).toBe(true)
  })
})
