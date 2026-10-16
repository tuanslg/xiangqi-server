import { describe, expect, it } from 'vitest'
import { fenProblem } from './validate'
import { START_FEN } from './types'

describe('fenProblem', () => {
  it('accepts the start position for both sides to move', () => {
    expect(fenProblem(START_FEN)).toBeNull()
    expect(fenProblem(START_FEN.replace(' w', ' b'))).toBeNull()
  })

  it('rejects malformed input', () => {
    expect(fenProblem('')).toBe('malformed FEN')
    expect(fenProblem('hello world')).toBe('malformed FEN')
    expect(fenProblem('x'.repeat(500))).toBe('FEN too long')
  })

  it('rejects a missing king', () => {
    expect(fenProblem('rnba1abnr/9/1c5c1/p1p1p1p1p/9/9/P1P1P1P1P/1C5C1/9/RNBAKABNR w')).toBe('each side needs exactly one king')
  })

  it('rejects too many pieces and unreachable squares', () => {
    expect(fenProblem('rnbakabnr/9/1c5c1/p1p1p1p1p/9/9/P1P1P1P1P/1C5C1/9/RRBAKABNR w')).toBe('too many red R')
    // black advisor swapped onto the king's file
    expect(fenProblem('rnbkaabnr/9/1c5c1/p1p1p1p1p/9/9/P1P1P1P1P/1C5C1/9/RNBAKABNR w')).toBe('advisor on an unreachable square')
    // red pawn behind its start rank
    expect(fenProblem('rnbakabnr/9/1c5c1/p1p1p1p1p/9/9/P1P1P1P1P/1C5C1/P8/RNBAKABNR w')).toBe('pawn on an unreachable square')
  })

  it('rejects a position where the side not to move is in check', () => {
    // red rook attacks the black king down the open file: fine with black to move, impossible with red to move
    const fen = '3k5/9/9/9/9/9/9/9/9/3R1K3'
    expect(fenProblem(`${fen} b`)).toBeNull()
    expect(fenProblem(`${fen} w`)).toBe('side not to move is in check')
  })
})
