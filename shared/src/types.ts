export type Color = 'red' | 'black'
export type PieceType = 'K' | 'A' | 'B' | 'N' | 'R' | 'C' | 'P'

export interface Piece {
  type: PieceType
  color: Color
}

/** Board is 10 rows (0 = black's back rank) x 9 columns. */
export type Board = (Piece | null)[][]

export interface Pos {
  row: number
  col: number
}

export interface Move {
  from: Pos
  to: Pos
}

export const ROWS = 10
export const COLS = 9
export const START_FEN =
  'rnbakabnr/9/1c5c1/p1p1p1p1p/9/9/P1P1P1P1P/1C5C1/9/RNBAKABNR w'
