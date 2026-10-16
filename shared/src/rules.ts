import type { Board, Color, Move, Pos } from './types'
import { COLS, ROWS } from './types'

const inBoard = (r: number, c: number) => r >= 0 && r < ROWS && c >= 0 && c < COLS
const inPalace = (color: Color, r: number, c: number) =>
  c >= 3 && c <= 5 && (color === 'red' ? r >= 7 && r <= 9 : r >= 0 && r <= 2)

/** Pseudo-legal destinations for the piece at `from` (ignores leaving own king in check). */
function pseudoTargets(board: Board, from: Pos): Pos[] {
  const piece = board[from.row][from.col]
  if (!piece) return []
  const { row, col } = from
  const out: Pos[] = []
  const push = (r: number, c: number) => {
    if (!inBoard(r, c)) return
    const t = board[r][c]
    if (!t || t.color !== piece.color) out.push({ row: r, col: c })
  }

  switch (piece.type) {
    case 'K':
      for (const [dr, dc] of [[1, 0], [-1, 0], [0, 1], [0, -1]])
        if (inPalace(piece.color, row + dr, col + dc)) push(row + dr, col + dc)
      break
    case 'A':
      for (const [dr, dc] of [[1, 1], [1, -1], [-1, 1], [-1, -1]])
        if (inPalace(piece.color, row + dr, col + dc)) push(row + dr, col + dc)
      break
    case 'B': {
      // Elephants cannot cross the river and are blocked at the "eye".
      for (const [dr, dc] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) {
        const r = row + 2 * dr
        const c = col + 2 * dc
        if (!inBoard(r, c) || board[row + dr][col + dc]) continue
        if (piece.color === 'red' ? r < 5 : r > 4) continue
        push(r, c)
      }
      break
    }
    case 'N':
      // Horse moves one orthogonal step (leg) then one diagonal; blocked if the leg is occupied.
      for (const [lr, lc, dr, dc] of [
        [-1, 0, -2, -1], [-1, 0, -2, 1], [1, 0, 2, -1], [1, 0, 2, 1],
        [0, -1, -1, -2], [0, -1, 1, -2], [0, 1, -1, 2], [0, 1, 1, 2],
      ]) {
        if (!inBoard(row + lr, col + lc) || board[row + lr][col + lc]) continue
        push(row + dr, col + dc)
      }
      break
    case 'R':
    case 'C':
      for (const [dr, dc] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        let r = row + dr
        let c = col + dc
        let screen = false
        while (inBoard(r, c)) {
          const t = board[r][c]
          if (piece.type === 'R') {
            if (!t) out.push({ row: r, col: c })
            else {
              if (t.color !== piece.color) out.push({ row: r, col: c })
              break
            }
          } else if (!screen) {
            if (!t) out.push({ row: r, col: c })
            else screen = true
          } else if (t) {
            if (t.color !== piece.color) out.push({ row: r, col: c })
            break
          }
          r += dr
          c += dc
        }
      }
      break
    case 'P': {
      const fwd = piece.color === 'red' ? -1 : 1
      push(row + fwd, col)
      const crossed = piece.color === 'red' ? row <= 4 : row >= 5
      if (crossed) {
        push(row, col - 1)
        push(row, col + 1)
      }
      break
    }
  }
  return out
}

function findKing(board: Board, color: Color): Pos | null {
  for (let r = 0; r < ROWS; r++)
    for (let c = 0; c < COLS; c++) {
      const p = board[r][c]
      if (p && p.type === 'K' && p.color === color) return { row: r, col: c }
    }
  return null
}

export function applyMove(board: Board, { from, to }: Move): Board {
  const next = board.map((r) => r.slice())
  next[to.row][to.col] = next[from.row][from.col]
  next[from.row][from.col] = null
  return next
}

/** True if `color`'s king is attacked, including the "flying general" face-off. */
export function isInCheck(board: Board, color: Color): boolean {
  const king = findKing(board, color)
  if (!king) return true
  const enemyKing = findKing(board, color === 'red' ? 'black' : 'red')
  if (enemyKing && enemyKing.col === king.col) {
    let blocked = false
    for (let r = Math.min(king.row, enemyKing.row) + 1; r < Math.max(king.row, enemyKing.row); r++)
      if (board[r][king.col]) blocked = true
    if (!blocked) return true
  }
  for (let r = 0; r < ROWS; r++)
    for (let c = 0; c < COLS; c++) {
      const p = board[r][c]
      if (p && p.color !== color)
        if (pseudoTargets(board, { row: r, col: c }).some((t) => t.row === king.row && t.col === king.col))
          return true
    }
  return false
}

export function legalMovesFrom(board: Board, from: Pos): Move[] {
  const piece = board[from.row][from.col]
  if (!piece) return []
  return pseudoTargets(board, from)
    .map((to) => ({ from, to }))
    .filter((m) => !isInCheck(applyMove(board, m), piece.color))
}

export function allLegalMoves(board: Board, color: Color): Move[] {
  const moves: Move[] = []
  for (let r = 0; r < ROWS; r++)
    for (let c = 0; c < COLS; c++)
      if (board[r][c]?.color === color) moves.push(...legalMovesFrom(board, { row: r, col: c }))
  return moves
}

/** No legal moves = loss in xiangqi (checkmate or stalemate). */
export function isCheckmate(board: Board, color: Color): boolean {
  return allLegalMoves(board, color).length === 0
}
