// Strength check for the difficulty levels: plays engine levels against each other.
// Usage: npx tsx scripts/selfplay.ts   (needs the engine: npm run engine:fetch)
import { toFen, toUciFen, uciToMove } from '@xiangqi/shared'
import type { Color } from '@xiangqi/shared'
import { loadConfig } from '../src/config'
import { EnginePool } from '../src/engine/pool'
import { firstLegal, getLevel, pickMove } from '../src/engine/levels'
import { XqGame } from '../src/online/game'

const c = loadConfig()
const pool = EnginePool.fromOptions({ binPath: c.pikafishPath, evalFile: c.pikafishEval, hashMb: 16, threads: 1 }, 4, 16)

async function game(redLevel: number, blackLevel: number): Promise<string> {
  const g = new XqGame(1e12, 0)
  g.start(0)
  let t = 0
  while (!g.result && g.moves.length < 240) {
    const color: Color = g.turn
    const level = getLevel(color === 'red' ? redLevel : blackLevel)!
    const fen = toFen({ board: g.board, turn: g.turn })
    const cands = await pool.search({ fen: toUciFen(fen), limits: level.limits, multipv: level.multipv, timeoutMs: 8000 })
    const chosen = pickMove(cands, level)
    const legal = firstLegal(fen, chosen ? [chosen, ...cands.filter((x) => x !== chosen)] : cands)
    if (!legal) return 'error'
    const m = uciToMove(legal.uci)!
    g.playMove(color, m, (t += 1))
  }
  if (!g.result) return `draw(ply limit)`
  return g.result.winner === null ? `draw(${g.result.reason})` : `${g.result.winner} wins (${g.result.reason}, ${g.moves.length} plies)`
}

async function main() {
  const pairs: [number, number][] = [[1, 3], [3, 1], [1, 2], [2, 1], [2, 4], [4, 2]]
  const out = await Promise.all(pairs.map(async ([r, b]) => `L${r}(red) vs L${b}(black): ${await game(r, b)}`))
  console.log(out.join('\n'))
  pool.close()
  process.exit(0)
}
void main()
