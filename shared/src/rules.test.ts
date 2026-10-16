import { describe, expect, it } from 'vitest'
import { parseFen, toFen } from './fen'
import { allLegalMoves, applyMove, isCheckmate, isInCheck, legalMovesFrom } from './rules'
import { START_FEN } from './types'

describe('xiangqi rules', () => {
  it('round-trips the start FEN', () => {
    expect(toFen(parseFen(START_FEN))).toBe(START_FEN)
  })

  it('red has 44 legal moves at the start', () => {
    const { board } = parseFen(START_FEN)
    expect(allLegalMoves(board, 'red')).toHaveLength(44)
  })

  it('horse is blocked by an adjacent piece (hobbling leg)', () => {
    const { board } = parseFen(START_FEN)
    // Red horse at (9,1): leg (8,1) empty -> 2 moves; (9,2) occupied blocks sideways.
    expect(legalMovesFrom(board, { row: 9, col: 1 })).toHaveLength(2)
  })

  it('detects flying general as check', () => {
    const { board } = parseFen('4k4/9/9/9/9/9/9/9/9/4K4 w')
    expect(isInCheck(board, 'red')).toBe(true)
  })

  it('detects checkmate by a double-rook ladder', () => {
    const { board } = parseFen('R3k4/8R/9/9/9/9/9/9/9/3K5 b')
    expect(isInCheck(board, 'black')).toBe(true)
    expect(isCheckmate(board, 'black')).toBe(true)
  })

  it('a position with an escape square is not checkmate', () => {
    const { board } = parseFen('R3k4/9/9/9/9/9/9/9/9/3K5 b')
    expect(isInCheck(board, 'black')).toBe(true)
    expect(isCheckmate(board, 'black')).toBe(false)
  })

  it('when in check, every piece only gets moves that resolve the check', () => {
    // Black rook on (4,4) checks the red general on (9,4); the red cannon on (9,0) and horse on (9,7) are idle.
    const { board } = parseFen('3k5/9/9/9/4r4/9/9/9/9/C2AK2N1 w')
    expect(isInCheck(board, 'red')).toBe(true)
    // General: only sideways off the file.
    expect(legalMovesFrom(board, { row: 9, col: 4 })).toEqual([{ from: { row: 9, col: 4 }, to: { row: 9, col: 5 } }])
    // Advisor: only the block on (8,4).
    expect(legalMovesFrom(board, { row: 9, col: 3 }).map((m) => m.to)).toEqual([{ row: 8, col: 4 }])
    // Cannon and horse cannot help, so they get nothing.
    expect(legalMovesFrom(board, { row: 9, col: 0 })).toEqual([])
    expect(legalMovesFrom(board, { row: 9, col: 7 })).toEqual([])
    // No suggested move leaves the general attacked.
    for (const m of allLegalMoves(board, 'red')) expect(isInCheck(applyMove(board, m), 'red')).toBe(false)
  })
})
