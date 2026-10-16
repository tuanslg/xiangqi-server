import { describe, expect, it } from 'vitest'
import { parseFen } from './fen'
import { allLegalMoves } from './rules'
import { moveToUci, toUciFen, uciToMove } from './uci'
import { START_FEN } from './types'

describe('uci conversion', () => {
  it('maps red cannon h2e2 and black horse b10-c8 style squares', () => {
    expect(uciToMove('h2e2')).toEqual({ from: { row: 7, col: 7 }, to: { row: 7, col: 4 } })
    expect(moveToUci({ from: { row: 0, col: 1 }, to: { row: 2, col: 2 } })).toBe('b9c7')
  })

  it('round-trips every legal opening move', () => {
    const { board } = parseFen(START_FEN)
    for (const m of allLegalMoves(board, 'red')) expect(uciToMove(moveToUci(m))).toEqual(m)
  })

  it('rejects malformed or off-board moves', () => {
    expect(uciToMove('z9a0')).toBeNull()
    expect(uciToMove('a0')).toBeNull()
    expect(uciToMove('(none)')).toBeNull()
  })

  it('builds a full UCI FEN', () => {
    expect(toUciFen(START_FEN)).toBe('rnbakabnr/9/1c5c1/p1p1p1p1p/9/9/P1P1P1P1P/1C5C1/9/RNBAKABNR w - - 0 1')
    expect(toUciFen('rnbakabnr/9/1c5c1/p1p1p1p1p/9/9/P1P1P1P1P/1C5C1/9/RNBAKABNR b')).toMatch(/ b - - 0 1$/)
  })
})
