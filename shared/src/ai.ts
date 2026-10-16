import { allLegalMoves, applyMove, isCheckmate } from './rules'
import type { Board, Color, Move } from './types'
import { COLS, ROWS } from './types'

/**
 * Engine interface. The built-in minimax below is a placeholder; swap in a
 * Pikafish WASM worker later by implementing the same signature.
 */
export type BestMoveFn = (board: Board, color: Color, depth: number) => Move | null

const VALUE = { K: 10000, R: 900, C: 450, N: 400, B: 200, A: 200, P: 100 } as const

function evaluate(board: Board, me: Color): number {
  let score = 0
  for (let r = 0; r < ROWS; r++)
    for (let c = 0; c < COLS; c++) {
      const p = board[r][c]
      if (!p) continue
      let v: number = VALUE[p.type]
      if (p.type === 'P') {
        const crossed = p.color === 'red' ? r <= 4 : r >= 5
        if (crossed) v += 100
      }
      score += p.color === me ? v : -v
    }
  return score
}

const other = (c: Color): Color => (c === 'red' ? 'black' : 'red')

function search(board: Board, turn: Color, me: Color, depth: number, alpha: number, beta: number): number {
  if (depth === 0) return evaluate(board, me)
  const moves = allLegalMoves(board, turn)
  if (moves.length === 0) return turn === me ? -100000 - depth : 100000 + depth
  // Captures first for better alpha-beta pruning.
  moves.sort((a, b) => Number(!!board[b.to.row][b.to.col]) - Number(!!board[a.to.row][a.to.col]))
  if (turn === me) {
    let best = -Infinity
    for (const m of moves) {
      best = Math.max(best, search(applyMove(board, m), other(turn), me, depth - 1, alpha, beta))
      alpha = Math.max(alpha, best)
      if (alpha >= beta) break
    }
    return best
  }
  let best = Infinity
  for (const m of moves) {
    best = Math.min(best, search(applyMove(board, m), other(turn), me, depth - 1, alpha, beta))
    beta = Math.min(beta, best)
    if (alpha >= beta) break
  }
  return best
}

export const minimaxBestMove: BestMoveFn = (board, color, depth) => {
  if (isCheckmate(board, color)) return null
  const moves = allLegalMoves(board, color)
  let bestScore = -Infinity
  let best: Move[] = []
  for (const m of moves) {
    const s = search(applyMove(board, m), other(color), color, depth - 1, -Infinity, Infinity)
    if (s > bestScore) {
      bestScore = s
      best = [m]
    } else if (s === bestScore) best.push(m)
  }
  return best[Math.floor(Math.random() * best.length)] ?? null
}
