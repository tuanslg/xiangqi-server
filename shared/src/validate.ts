import { parseFen } from './fen'
import { isInCheck } from './rules'
import type { Board, Color, PieceType } from './types'
import { COLS, ROWS } from './types'

const MAX_COUNT: Record<PieceType, number> = { K: 1, A: 2, B: 2, N: 2, R: 2, C: 2, P: 5 }

const sq = (...pairs: [number, number][]) => new Set(pairs.map(([r, c]) => r * COLS + c))

/** Squares each side's palace pieces and elephants can ever occupy. */
const KING_SQ: Record<Color, Set<number>> = {
  red: sq(...[7, 8, 9].flatMap((r) => [3, 4, 5].map((c): [number, number] => [r, c]))),
  black: sq(...[0, 1, 2].flatMap((r) => [3, 4, 5].map((c): [number, number] => [r, c]))),
}
const ADVISOR_SQ: Record<Color, Set<number>> = {
  red: sq([9, 3], [9, 5], [8, 4], [7, 3], [7, 5]),
  black: sq([0, 3], [0, 5], [1, 4], [2, 3], [2, 5]),
}
const ELEPHANT_SQ: Record<Color, Set<number>> = {
  red: sq([9, 2], [9, 6], [7, 0], [7, 4], [7, 8], [5, 2], [5, 6]),
  black: sq([0, 2], [0, 6], [2, 0], [2, 4], [2, 8], [4, 2], [4, 6]),
}

function pawnOk(color: Color, r: number, c: number): boolean {
  // Pawns never move backwards and only change file after crossing the river.
  if (color === 'red') return r <= 6 && (r <= 4 || c % 2 === 0)
  return r >= 3 && (r >= 5 || c % 2 === 0)
}

/** Returns a human-readable reason if the board cannot arise in a real game, else null. */
export function boardProblem(board: Board): string | null {
  const count: Record<string, number> = {}
  for (let r = 0; r < ROWS; r++)
    for (let c = 0; c < COLS; c++) {
      const p = board[r][c]
      if (!p) continue
      const key = p.color + p.type
      count[key] = (count[key] ?? 0) + 1
      const at = r * COLS + c
      if (p.type === 'K' && !KING_SQ[p.color].has(at)) return 'king outside palace'
      if (p.type === 'A' && !ADVISOR_SQ[p.color].has(at)) return 'advisor on an unreachable square'
      if (p.type === 'B' && !ELEPHANT_SQ[p.color].has(at)) return 'elephant on an unreachable square'
      if (p.type === 'P' && !pawnOk(p.color, r, c)) return 'pawn on an unreachable square'
    }
  for (const color of ['red', 'black'] as const)
    for (const t of Object.keys(MAX_COUNT) as PieceType[])
      if ((count[color + t] ?? 0) > MAX_COUNT[t]) return `too many ${color} ${t}`
  if (count.redK !== 1 || count.blackK !== 1) return 'each side needs exactly one king'
  return null
}

/** Throw-free check for untrusted FEN strings. Returns an error message, or null when valid. */
export function fenProblem(fen: string): string | null {
  if (fen.length > 120) return 'FEN too long'
  let pos
  try {
    pos = parseFen(fen)
  } catch {
    return 'malformed FEN'
  }
  const problem = boardProblem(pos.board)
  if (problem) return problem
  // The side that just moved cannot have left its own king en prise.
  const mover: Color = pos.turn === 'red' ? 'black' : 'red'
  if (isInCheck(pos.board, mover)) return 'side not to move is in check'
  return null
}
