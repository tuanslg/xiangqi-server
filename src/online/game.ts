import { allLegalMoves, applyMove, isInCheck, legalMovesFrom, parseFen, toFen, START_FEN } from '@xiangqi/shared'
import type { Board, Color, GameResult, Move } from '@xiangqi/shared'

/** 60 moves each without a capture is a draw (the common "natural limit" rule). */
export const NO_CAPTURE_PLY_LIMIT = 120

const other = (c: Color): Color => (c === 'red' ? 'black' : 'red')
const same = (a: Move, b: Move) =>
  a.from.row === b.from.row && a.from.col === b.from.col && a.to.row === b.to.row && a.to.col === b.to.col

export type MoveOutcome =
  | { ok: true }
  | { ok: false; reason: 'finished' | 'not_your_turn' | 'illegal' | 'timeout' }

/**
 * Authoritative state of one xiangqi game: rules, clocks and end conditions. Pure: no timers or
 * I/O, and time is passed in, so every rule is testable deterministically.
 *
 * Repetition: the third occurrence of a position ends the game. If only one side delivered check
 * on every move of the cycle, that side loses (perpetual check); otherwise it is a draw.
 * Perpetual *chase* is not detected.
 */
export class XqGame {
  board: Board
  turn: Color
  lastMove: Move | null = null
  readonly moves: Move[] = []
  result: GameResult | null = null
  drawOffer: Color | null = null
  readonly baseMs: number
  readonly incMs: number

  private remainingMs: Record<Color, number>
  /** Wall-clock ms at which the side to move's clock started running; null before start. */
  private tickAt: number | null = null
  private readonly keys: string[]
  private readonly counts = new Map<string, number>()
  /** gaveCheck[i] is whether ply i+1 delivered check. */
  private readonly gaveCheck: boolean[] = []
  private pliesSinceCapture = 0

  constructor(baseMs: number, incMs: number, fen: string = START_FEN) {
    const pos = parseFen(fen)
    this.board = pos.board
    this.turn = pos.turn
    this.baseMs = baseMs
    this.incMs = incMs
    this.remainingMs = { red: baseMs, black: baseMs }
    const key = toFen(pos)
    this.keys = [key]
    this.counts.set(key, 1)
  }

  get started(): boolean {
    return this.tickAt !== null
  }

  start(now: number): void {
    this.tickAt = now
  }

  /** Remaining ms for `color`, accounting for the running clock if it is their turn. */
  remaining(color: Color, now: number): number {
    const base = this.remainingMs[color]
    if (this.result || this.tickAt === null || this.turn !== color) return Math.max(0, base)
    return Math.max(0, base - (now - this.tickAt))
  }

  /** Ends the game on time if the side to move has run out. Returns true if it did. */
  flag(now: number): boolean {
    if (this.result || this.tickAt === null) return false
    if (this.remaining(this.turn, now) > 0) return false
    this.remainingMs[this.turn] = 0
    this.finish({ winner: other(this.turn), reason: 'timeout' })
    return true
  }

  playMove(color: Color, move: Move, now: number): MoveOutcome {
    if (this.result) return { ok: false, reason: 'finished' }
    if (this.tickAt === null || color !== this.turn) return { ok: false, reason: 'not_your_turn' }
    if (this.flag(now)) return { ok: false, reason: 'timeout' }

    const legal = legalMovesFrom(this.board, move.from)
    const piece = this.board[move.from.row][move.from.col]
    if (!piece || piece.color !== color || !legal.some((m) => same(m, move))) return { ok: false, reason: 'illegal' }

    const captured = this.board[move.to.row][move.to.col] !== null
    this.remainingMs[color] = this.remaining(color, now) + this.incMs
    this.board = applyMove(this.board, move)
    this.turn = other(color)
    this.tickAt = now
    this.lastMove = move
    this.moves.push(move)
    this.drawOffer = null
    this.pliesSinceCapture = captured ? 0 : this.pliesSinceCapture + 1

    const check = isInCheck(this.board, this.turn)
    this.gaveCheck.push(check)
    const key = toFen({ board: this.board, turn: this.turn })
    this.keys.push(key)
    const seen = (this.counts.get(key) ?? 0) + 1
    this.counts.set(key, seen)

    if (allLegalMoves(this.board, this.turn).length === 0) this.finish({ winner: color, reason: 'checkmate' })
    else if (seen >= 3) this.finish(this.repetitionResult(key))
    else if (this.pliesSinceCapture >= NO_CAPTURE_PLY_LIMIT) this.finish({ winner: null, reason: 'no_capture' })
    return { ok: true }
  }

  resign(color: Color): boolean {
    if (this.result) return false
    this.finish({ winner: other(color), reason: 'resign' })
    return true
  }

  offerDraw(color: Color): boolean {
    if (this.result || this.tickAt === null || this.drawOffer === color) return false
    if (this.moves.length < 2) return false // no draw offers before each side has moved
    if (this.drawOffer === other(color)) return this.acceptDraw(color) // crossing offers = agreement
    this.drawOffer = color
    return true
  }

  acceptDraw(color: Color): boolean {
    if (this.result || this.drawOffer !== other(color)) return false
    this.finish({ winner: null, reason: 'agreement' })
    return true
  }

  declineDraw(color: Color): boolean {
    if (this.result || this.drawOffer !== other(color)) return false
    this.drawOffer = null
    return true
  }

  abandon(loser: Color): void {
    if (!this.result) this.finish({ winner: other(loser), reason: 'abandoned' })
  }

  private finish(result: GameResult): void {
    this.result = result
    this.drawOffer = null
  }

  private repetitionResult(key: string): GameResult {
    const last = this.keys.length - 1
    const first = this.keys.indexOf(key)
    const checking: Record<Color, boolean> = { red: true, black: true }
    const moved: Record<Color, boolean> = { red: false, black: false }
    for (let ply = first + 1; ply <= last; ply++) {
      // The side that played ply `ply` is the one who was NOT to move in keys[ply].
      const mover: Color = ply % 2 === 1 ? this.startMover() : other(this.startMover())
      moved[mover] = true
      if (!this.gaveCheck[ply - 1]) checking[mover] = false
    }
    const redPerp = moved.red && checking.red
    const blackPerp = moved.black && checking.black
    if (redPerp && !blackPerp) return { winner: 'black', reason: 'perpetual_check' }
    if (blackPerp && !redPerp) return { winner: 'red', reason: 'perpetual_check' }
    return { winner: null, reason: 'repetition' }
  }

  private startMover(): Color {
    return parseFen(this.keys[0]).turn
  }
}
