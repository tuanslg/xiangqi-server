import type { Move } from '@xiangqi/shared'
import { allLegalMoves, parseFen, uciToMove } from '@xiangqi/shared'
import type { Candidate, SearchLimits } from './uciEngine'

export interface Level {
  id: number
  label: string
  limits: SearchLimits
  /** Number of candidate lines requested; > 1 lets weaker levels pick a non-best move. */
  multipv: number
  /** Chance of deliberately playing a non-best move. */
  blunderChance: number
  /** A blunder is only chosen among moves at most this many centipawns worse than the best. */
  maxLossCp: number
}

/**
 * Pikafish has no Skill Level / UCI_Elo option, so strength is shaped by search
 * budget plus occasional sub-optimal choices among the top MultiPV lines.
 */
export const LEVELS: readonly Level[] = [
  { id: 1, label: 'Dễ', limits: { depth: 1 }, multipv: 6, blunderChance: 0.6, maxLossCp: 400 },
  { id: 2, label: 'Trung bình', limits: { depth: 5 }, multipv: 4, blunderChance: 0.3, maxLossCp: 200 },
  { id: 3, label: 'Khó', limits: { movetime: 400 }, multipv: 2, blunderChance: 0.1, maxLossCp: 60 },
  { id: 4, label: 'Siêu khó', limits: { movetime: 1500 }, multipv: 1, blunderChance: 0, maxLossCp: 0 },
]

export const getLevel = (id: number): Level | undefined => LEVELS.find((l) => l.id === id)

/** Picks the move to play from the engine's ranked candidates (best first). */
export function pickMove(candidates: Candidate[], level: Level, random: () => number = Math.random): Candidate | null {
  if (candidates.length === 0) return null
  const best = candidates[0]
  if (candidates.length === 1 || random() >= level.blunderChance) return best
  // Never throw away a forced mate or walk into one just to look human.
  if (Math.abs(best.score) >= 20_000) return best
  const pool = candidates.filter((c) => best.score - c.score <= level.maxLossCp)
  return pool[Math.floor(random() * pool.length)] ?? best
}

/** Defence in depth: the engine's move must be legal under our own rules before we send it out. */
export function firstLegal(fen: string, candidates: Candidate[]): { move: Move; uci: string } | null {
  const { board, turn } = parseFen(fen)
  const legal = allLegalMoves(board, turn)
  for (const c of candidates) {
    const m = uciToMove(c.move)
    if (m && legal.some((l) => l.from.row === m.from.row && l.from.col === m.from.col && l.to.row === m.to.row && l.to.col === m.to.col))
      return { move: m, uci: c.move }
  }
  return null
}
