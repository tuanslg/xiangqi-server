import { describe, expect, it } from 'vitest'
import { fenProblem } from '@xiangqi/shared'
import type { Color, Move } from '@xiangqi/shared'
import { NO_CAPTURE_PLY_LIMIT, XqGame } from './game'

const mv = (fr: number, fc: number, tr: number, tc: number): Move => ({ from: { row: fr, col: fc }, to: { row: tr, col: tc } })

function started(fen?: string, base = 60_000, inc = 1_000) {
  const g = new XqGame(base, inc, fen)
  g.start(0)
  return g
}

/** Plays moves alternately starting with `first`, 1s apart; fails the test on any rejection. */
function play(g: XqGame, first: Color, moves: Move[], t0 = 0) {
  let color = first
  moves.forEach((m, i) => {
    const out = g.playMove(color, m, t0 + (i + 1) * 1000)
    expect(out, `move ${i + 1}`).toEqual({ ok: true })
    color = color === 'red' ? 'black' : 'red'
  })
}

describe('XqGame moves', () => {
  it('enforces turn order and legality', () => {
    const g = started()
    expect(g.playMove('black', mv(3, 0, 4, 0), 1)).toEqual({ ok: false, reason: 'not_your_turn' })
    expect(g.playMove('red', mv(0, 0, 1, 0), 1)).toEqual({ ok: false, reason: 'illegal' }) // black's rook
    expect(g.playMove('red', mv(9, 0, 5, 0), 1)).toEqual({ ok: false, reason: 'illegal' }) // blocked rook
    expect(g.playMove('red', mv(7, 1, 7, 4), 1)).toEqual({ ok: true }) // cannon h2-e2 style
    expect(g.turn).toBe('black')
    expect(g.moves).toHaveLength(1)
  })

  it('refuses moves before the game starts', () => {
    const g = new XqGame(1000, 0)
    expect(g.playMove('red', mv(7, 1, 7, 4), 0)).toEqual({ ok: false, reason: 'not_your_turn' })
  })

  it('refuses moves after the game ended', () => {
    const g = started()
    g.resign('red')
    expect(g.playMove('red', mv(7, 1, 7, 4), 1)).toEqual({ ok: false, reason: 'finished' })
  })

  it('ends with checkmate', () => {
    const fen = '4k4/8R/R8/9/9/9/9/9/9/3K5 w'
    expect(fenProblem(fen)).toBeNull()
    const g = started(fen)
    expect(g.playMove('red', mv(2, 0, 0, 0), 1)).toEqual({ ok: true })
    expect(g.result).toEqual({ winner: 'red', reason: 'checkmate' })
  })
})

describe('XqGame clocks', () => {
  it('deducts elapsed time and adds the increment to the mover only', () => {
    const g = started(undefined, 60_000, 1_000)
    expect(g.remaining('red', 10_000)).toBe(50_000)
    expect(g.remaining('black', 10_000)).toBe(60_000)
    g.playMove('red', mv(7, 1, 7, 4), 10_000)
    expect(g.remaining('red', 99_000)).toBe(51_000) // frozen while black thinks
    expect(g.remaining('black', 15_000)).toBe(55_000)
  })

  it('flags the side to move when time runs out', () => {
    const g = started(undefined, 5_000, 0)
    expect(g.flag(4_999)).toBe(false)
    expect(g.flag(5_000)).toBe(true)
    expect(g.result).toEqual({ winner: 'black', reason: 'timeout' })
    expect(g.flag(9_000)).toBe(false)
  })

  it('rejects a move that arrives after the clock ran out and records the timeout', () => {
    const g = started(undefined, 5_000, 0)
    expect(g.playMove('red', mv(7, 1, 7, 4), 6_000)).toEqual({ ok: false, reason: 'timeout' })
    expect(g.result).toEqual({ winner: 'black', reason: 'timeout' })
    expect(g.moves).toHaveLength(0)
  })
})

describe('XqGame draw offers and resignation', () => {
  it('resign gives the win to the opponent', () => {
    const g = started()
    expect(g.resign('black')).toBe(true)
    expect(g.result).toEqual({ winner: 'red', reason: 'resign' })
    expect(g.resign('red')).toBe(false)
  })

  it('needs both sides to have moved before a draw can be offered', () => {
    const g = started()
    expect(g.offerDraw('red')).toBe(false)
    play(g, 'red', [mv(7, 1, 7, 4), mv(2, 1, 2, 4)])
    expect(g.offerDraw('red')).toBe(true)
    expect(g.offerDraw('red')).toBe(false) // already pending
  })

  it('accept ends the game as a draw; only the opponent can accept or decline', () => {
    const g = started()
    play(g, 'red', [mv(7, 1, 7, 4), mv(2, 1, 2, 4)])
    g.offerDraw('red')
    expect(g.acceptDraw('red')).toBe(false)
    expect(g.declineDraw('red')).toBe(false)
    expect(g.acceptDraw('black')).toBe(true)
    expect(g.result).toEqual({ winner: null, reason: 'agreement' })
  })

  it('a move clears a pending offer, and decline clears it too', () => {
    const g = started()
    play(g, 'red', [mv(7, 1, 7, 4), mv(2, 1, 2, 4)])
    g.offerDraw('red')
    expect(g.declineDraw('black')).toBe(true)
    expect(g.drawOffer).toBeNull()
    g.offerDraw('red')
    g.playMove('red', mv(9, 1, 7, 2), 5_000)
    expect(g.drawOffer).toBeNull()
  })

  it('crossing offers count as agreement', () => {
    const g = started()
    play(g, 'red', [mv(7, 1, 7, 4), mv(2, 1, 2, 4)])
    g.offerDraw('red')
    expect(g.offerDraw('black')).toBe(true)
    expect(g.result?.reason).toBe('agreement')
  })
})

describe('XqGame repetition', () => {
  it('draws on the third occurrence when nobody is checking', () => {
    const fen = 'r2k5/9/9/9/9/9/9/9/9/R4K3 w'
    expect(fenProblem(fen)).toBeNull()
    const g = started(fen)
    const cycle = [mv(9, 0, 8, 0), mv(0, 0, 1, 0), mv(8, 0, 9, 0), mv(1, 0, 0, 0)]
    play(g, 'red', cycle)
    expect(g.result).toBeNull() // second occurrence: still playing
    play(g, 'red', cycle, 4000)
    expect(g.result).toEqual({ winner: null, reason: 'repetition' })
  })

  it('makes the side that checks on every move of the cycle lose', () => {
    const fen = '4k4/9/9/9/9/3R5/9/9/9/5K3 w'
    expect(fenProblem(fen)).toBeNull()
    const g = started(fen)
    const cycle = [mv(5, 3, 5, 4), mv(0, 4, 0, 3), mv(5, 4, 5, 3), mv(0, 3, 0, 4)]
    play(g, 'red', cycle)
    expect(g.result).toBeNull()
    play(g, 'red', cycle, 4000)
    expect(g.result).toEqual({ winner: 'black', reason: 'perpetual_check' })
  })

  it('draws on the no-capture limit', () => {
    const g = started('r2k5/9/9/9/9/9/9/9/9/R4K3 w')
    // @ts-expect-error reach into private state to avoid playing 119 plies
    g.pliesSinceCapture = NO_CAPTURE_PLY_LIMIT - 1
    g.playMove('red', mv(9, 0, 8, 0), 1)
    expect(g.result).toEqual({ winner: null, reason: 'no_capture' })
  })
})
