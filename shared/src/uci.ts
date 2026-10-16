import { parseFen } from './fen'
import type { Move } from './types'
import { COLS, ROWS } from './types'

/**
 * Pikafish speaks UCI-xiangqi: files a-i left to right, ranks 0-9 from red's side.
 * Our board has row 0 at black's back rank, so rank = ROWS - 1 - row.
 */
export function moveToUci({ from, to }: Move): string {
  const sq = (p: { row: number; col: number }) => String.fromCharCode(97 + p.col) + (ROWS - 1 - p.row)
  return sq(from) + sq(to)
}

export function uciToMove(uci: string): Move | null {
  const m = /^([a-i])([0-9])([a-i])([0-9])$/.exec(uci)
  if (!m) return null
  const col = (ch: string) => ch.charCodeAt(0) - 97
  const row = (d: string) => ROWS - 1 - Number(d)
  const move: Move = {
    from: { row: row(m[2]), col: col(m[1]) },
    to: { row: row(m[4]), col: col(m[3]) },
  }
  const ok = (p: { row: number; col: number }) => p.row >= 0 && p.row < ROWS && p.col >= 0 && p.col < COLS
  return ok(move.from) && ok(move.to) ? move : null
}

/** Full UCI FEN (adds the castling/en-passant/clock fields our short FEN omits). */
export function toUciFen(fen: string): string {
  const { turn } = parseFen(fen) // validates the placement as a side effect
  const placement = fen.trim().split(/\s+/)[0]
  return `${placement} ${turn === 'red' ? 'w' : 'b'} - - 0 1`
}
