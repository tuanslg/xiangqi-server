import { describe, expect, it } from 'vitest'
import { START_FEN } from '@xiangqi/shared'
import { LEVELS, firstLegal, getLevel, pickMove } from './levels'
import { parseInfo } from './uciEngine'
import type { Candidate } from './uciEngine'

const cands: Candidate[] = [
  { move: 'h2e2', score: 50, depth: 5 },
  { move: 'b2e2', score: 40, depth: 5 },
  { move: 'a3a4', score: -300, depth: 5 },
]

describe('pickMove', () => {
  it('returns null without candidates and the only candidate when alone', () => {
    expect(pickMove([], LEVELS[0])).toBeNull()
    expect(pickMove([cands[0]], LEVELS[0], () => 0)).toBe(cands[0])
  })

  it('plays the best move when the blunder roll misses', () => {
    expect(pickMove(cands, getLevel(1)!, () => 0.99)).toBe(cands[0])
  })

  it('on a blunder only chooses moves within the allowed loss', () => {
    const level = getLevel(2)! // maxLossCp 200 -> the -300 move is excluded
    const seen = new Set<string>()
    for (let i = 0; i < 100; i++) {
      // first call decides "blunder?", second picks inside the pool
      const rolls = [0, i / 100]
      seen.add(pickMove(cands, level, () => rolls.shift() ?? 0)!.move)
    }
    expect(seen).toEqual(new Set(['h2e2', 'b2e2']))
  })

  it('never blunders away a mate', () => {
    const mate: Candidate[] = [{ move: 'a0a1', score: 29_999, depth: 9 }, { move: 'b0b1', score: 0, depth: 9 }]
    expect(pickMove(mate, getLevel(1)!, () => 0)).toBe(mate[0])
  })

  it('the top level never blunders', () => {
    expect(getLevel(4)!.blunderChance).toBe(0)
  })
})

describe('firstLegal', () => {
  it('skips illegal engine moves', () => {
    const r = firstLegal(START_FEN, [{ move: 'a0a5', score: 0, depth: 1 }, { move: 'h2e2', score: 0, depth: 1 }])
    expect(r?.uci).toBe('h2e2')
  })

  it('returns null when nothing is legal', () => {
    expect(firstLegal(START_FEN, [{ move: 'e0e5', score: 0, depth: 1 }])).toBeNull()
  })
})

describe('parseInfo', () => {
  it('parses cp scores', () => {
    const line = 'info depth 6 seldepth 11 multipv 2 score cp -52 nodes 2613 nps 871000 hashfull 0 tbhits 0 time 3 pv h2e2 h9g7 h0g2'
    expect(parseInfo(line)).toEqual({ index: 2, cand: { move: 'h2e2', score: -52, depth: 6 } })
  })

  it('maps mate scores to large magnitudes, nearer mates being bigger', () => {
    const win = parseInfo('info depth 9 multipv 1 score mate 3 pv h2h9')!
    const win1 = parseInfo('info depth 9 multipv 1 score mate 1 pv h2h9')!
    const lose = parseInfo('info depth 9 multipv 1 score mate -2 pv h2h9')!
    expect(win.cand.score).toBeGreaterThan(20_000)
    expect(win1.cand.score).toBeGreaterThan(win.cand.score)
    expect(lose.cand.score).toBeLessThan(-20_000)
  })

  it('ignores lines without a pv', () => {
    expect(parseInfo('info string NNUE evaluation using pikafish.nnue enabled')).toBeNull()
  })
})
