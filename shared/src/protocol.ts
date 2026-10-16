import type { Color, Move, Pos } from './types'
import { COLS, ROWS } from './types'

export const TIME_CONTROLS = {
  '3+2': { baseMs: 3 * 60_000, incMs: 2_000 },
  '5+3': { baseMs: 5 * 60_000, incMs: 3_000 },
  '10+5': { baseMs: 10 * 60_000, incMs: 5_000 },
  '30+0': { baseMs: 30 * 60_000, incMs: 0 },
} as const

export type TimeControlId = keyof typeof TIME_CONTROLS
export const isTimeControlId = (v: unknown): v is TimeControlId =>
  typeof v === 'string' && Object.prototype.hasOwnProperty.call(TIME_CONTROLS, v)

export type GameReason =
  | 'checkmate' // includes stalemate: having no legal move loses in xiangqi
  | 'timeout'
  | 'resign'
  | 'agreement'
  | 'repetition'
  | 'perpetual_check'
  | 'no_capture'
  | 'abandoned'

export interface GameResult {
  /** null = draw */
  winner: Color | null
  reason: GameReason
}

export interface SeatInfo {
  name: string
  /** Whether the player currently has a live connection. */
  online: boolean
}

export interface RoomSnapshot {
  code: string
  tc: TimeControlId
  status: 'waiting' | 'playing' | 'finished'
  fen: string
  /** Side to move. */
  turn: Color
  /** Which side the receiving player controls. */
  you: Color
  red: SeatInfo | null
  black: SeatInfo | null
  lastMove: Move | null
  moveCount: number
  /** Remaining time in ms as of `serverTime`; only the side to move's clock is running. */
  clocks: { red: number; black: number; serverTime: number }
  drawOffer: Color | null
  result: GameResult | null
}

export type ClientMessage =
  | { t: 'create'; color: Color | 'random'; tc: TimeControlId }
  | { t: 'join'; code: string }
  | { t: 'quick'; tc: TimeControlId }
  | { t: 'cancelQuick' }
  | { t: 'move'; from: Pos; to: Pos }
  | { t: 'resign' }
  | { t: 'draw'; action: 'offer' | 'accept' | 'decline' }
  | { t: 'leave' }
  | { t: 'ping' }

export type ServerMessage =
  | { t: 'welcome'; name: string; signedIn: boolean; room: RoomSnapshot | null }
  | { t: 'room'; room: RoomSnapshot }
  | { t: 'left' }
  | { t: 'queued'; tc: TimeControlId }
  | { t: 'dequeued' }
  | { t: 'error'; code: string; message: string }
  | { t: 'pong' }

export const ROOM_CODE_RE = /^[A-HJ-NP-Z2-9]{6}$/

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const isPos = (v: unknown): v is Pos =>
  isObj(v) && Number.isInteger(v.row) && Number.isInteger(v.col) &&
  (v.row as number) >= 0 && (v.row as number) < ROWS && (v.col as number) >= 0 && (v.col as number) < COLS

/** Validates an untrusted decoded JSON value; returns null for anything malformed. */
export function parseClientMessage(raw: unknown): ClientMessage | null {
  if (!isObj(raw) || typeof raw.t !== 'string') return null
  switch (raw.t) {
    case 'create':
      return (raw.color === 'red' || raw.color === 'black' || raw.color === 'random') && isTimeControlId(raw.tc)
        ? { t: 'create', color: raw.color, tc: raw.tc }
        : null
    case 'join': {
      const code = typeof raw.code === 'string' ? raw.code.trim().toUpperCase() : ''
      return ROOM_CODE_RE.test(code) ? { t: 'join', code } : null
    }
    case 'quick':
      return isTimeControlId(raw.tc) ? { t: 'quick', tc: raw.tc } : null
    case 'move':
      return isPos(raw.from) && isPos(raw.to)
        ? { t: 'move', from: { row: raw.from.row, col: raw.from.col }, to: { row: raw.to.row, col: raw.to.col } }
        : null
    case 'draw':
      return raw.action === 'offer' || raw.action === 'accept' || raw.action === 'decline'
        ? { t: 'draw', action: raw.action }
        : null
    case 'cancelQuick':
    case 'resign':
    case 'leave':
    case 'ping':
      return { t: raw.t }
    default:
      return null
  }
}
