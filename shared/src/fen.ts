import type { Board, Color, Piece, PieceType } from './types'
import { COLS, ROWS } from './types'

export interface Position {
  board: Board
  turn: Color
}

export function parseFen(fen: string): Position {
  const [placement, side = 'w'] = fen.trim().split(/\s+/)
  const rows = placement.split('/')
  if (rows.length !== ROWS) throw new Error(`Invalid FEN rows: ${fen}`)
  const board: Board = rows.map((r) => {
    const line: (Piece | null)[] = []
    for (const ch of r) {
      if (/\d/.test(ch)) {
        for (let i = 0; i < Number(ch); i++) line.push(null)
      } else {
        const color: Color = ch === ch.toUpperCase() ? 'red' : 'black'
        line.push({ type: ch.toUpperCase() as PieceType, color })
      }
    }
    if (line.length !== COLS) throw new Error(`Invalid FEN row: ${r}`)
    return line
  })
  return { board, turn: side === 'b' ? 'black' : 'red' }
}

export function toFen({ board, turn }: Position): string {
  const placement = board
    .map((row) => {
      let out = ''
      let empty = 0
      for (const cell of row) {
        if (!cell) {
          empty++
          continue
        }
        if (empty) out += empty
        empty = 0
        out += cell.color === 'red' ? cell.type : cell.type.toLowerCase()
      }
      return out + (empty || '')
    })
    .join('/')
  return `${placement} ${turn === 'red' ? 'w' : 'b'}`
}
