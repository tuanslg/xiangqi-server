import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { START_FEN } from '@xiangqi/shared'
import type { Color, RoomSnapshot, ServerMessage } from '@xiangqi/shared'
import { Hub } from './hub'
import type { Conn, GameRecord, Identity } from './hub'

class FakeConn implements Conn {
  msgs: ServerMessage[] = []
  closed: { code: number; reason: string } | null = null
  readonly identity: Identity
  constructor(identity: Identity) {
    this.identity = identity
  }
  send(msg: ServerMessage) {
    this.msgs.push(msg)
  }
  close(code: number, reason: string) {
    this.closed = { code, reason }
  }
  /** Latest room snapshot this connection has received. */
  get room(): RoomSnapshot | null {
    for (let i = this.msgs.length - 1; i >= 0; i--) {
      const m = this.msgs[i]
      if (m.t === 'room') return m.room
      if (m.t === 'welcome') return m.room
    }
    return null
  }
  get lastError(): string | null {
    const e = [...this.msgs].reverse().find((m) => m.t === 'error')
    return e && e.t === 'error' ? e.code : null
  }
}

const player = (n: string, userId: string | null = null): FakeConn =>
  new FakeConn({ key: userId ? `u:${userId}` : `g:${n}`, name: n, userId })

const E = (fr: number, fc: number, tr: number, tc: number) => ({ from: { row: fr, col: fc }, to: { row: tr, col: tc } })
const RED_OPEN = E(7, 1, 7, 4) // red cannon to the centre file
const BLACK_OPEN = E(2, 1, 2, 4)

let hub: Hub
let saved: GameRecord[]

beforeEach(() => {
  vi.useFakeTimers()
  saved = []
  hub = new Hub({ saveGame: async (r) => void saved.push(r) })
})
afterEach(() => {
  hub.close()
  vi.useRealTimers()
})

/** Two connected players in a started game; returns them keyed by colour. */
function startedGame(tc: '3+2' | '30+0' = '3+2') {
  const a = player('An')
  const b = player('Binh')
  hub.connect(a)
  hub.connect(b)
  hub.handle(a, { t: 'create', color: 'red', tc })
  hub.handle(b, { t: 'join', code: a.room!.code })
  return { red: a, black: b }
}

describe('rooms', () => {
  it('creates a waiting room with a readable code, then starts when someone joins', () => {
    const a = player('An')
    const b = player('Binh')
    hub.connect(a)
    hub.connect(b)
    hub.handle(a, { t: 'create', color: 'black', tc: '5+3' })
    expect(a.room).toMatchObject({ status: 'waiting', you: 'black', red: null, fen: expect.stringContaining('rnbakabnr') })
    expect(a.room!.code).toMatch(/^[A-HJ-NP-Z2-9]{6}$/)

    hub.handle(b, { t: 'join', code: a.room!.code })
    expect(a.room).toMatchObject({ status: 'playing', you: 'black', red: { name: 'Binh' }, black: { name: 'An' } })
    expect(b.room).toMatchObject({ status: 'playing', you: 'red' })
    expect(b.room!.fen).toBe(START_FEN)
  })

  it('rejects unknown, own and full rooms', () => {
    const { red } = startedGame()
    const c = player('Chi')
    hub.connect(c)
    hub.handle(c, { t: 'join', code: 'ZZZZZZ' })
    expect(c.lastError).toBe('room_not_found')
    hub.handle(c, { t: 'join', code: red.room!.code })
    expect(c.lastError).toBe('room_full')
    hub.handle(red, { t: 'join', code: red.room!.code })
    expect(red.lastError).toBe('already_in_room')
  })

  it('refuses a second room while one is live, but releases a finished one', () => {
    const { red } = startedGame()
    hub.handle(red, { t: 'create', color: 'red', tc: '3+2' })
    expect(red.lastError).toBe('already_in_room')
    hub.handle(red, { t: 'resign' })
    hub.handle(red, { t: 'create', color: 'red', tc: '3+2' })
    expect(red.room).toMatchObject({ status: 'waiting' })
  })

  it('expires a room nobody joins and tells its owner', () => {
    const a = player('An')
    hub.connect(a)
    hub.handle(a, { t: 'create', color: 'red', tc: '3+2' })
    const code = a.room!.code
    vi.advanceTimersByTime(15 * 60_000 + 1)
    expect(a.msgs.some((m) => m.t === 'left')).toBe(true)
    expect(hub.roomCount).toBe(0)
    const b = player('Binh')
    hub.connect(b)
    hub.handle(b, { t: 'join', code })
    expect(b.lastError).toBe('room_not_found')
  })

  it('caps the number of rooms', () => {
    hub.close()
    hub = new Hub({ maxRooms: 1 })
    const a = player('An')
    const b = player('Binh')
    hub.connect(a)
    hub.connect(b)
    hub.handle(a, { t: 'create', color: 'red', tc: '3+2' })
    hub.handle(b, { t: 'create', color: 'red', tc: '3+2' })
    expect(b.lastError).toBe('server_full')
  })

  it('lets a waiting owner leave, deleting the room', () => {
    const a = player('An')
    hub.connect(a)
    hub.handle(a, { t: 'create', color: 'red', tc: '3+2' })
    hub.handle(a, { t: 'leave' })
    expect(a.msgs.at(-1)).toEqual({ t: 'left' })
    expect(hub.roomCount).toBe(0)
  })
})

describe('matchmaking', () => {
  it('pairs two players with the same time control and gives them opposite colours', () => {
    const a = player('An')
    const b = player('Binh')
    hub.connect(a)
    hub.connect(b)
    hub.handle(a, { t: 'quick', tc: '5+3' })
    expect(a.msgs.at(-1)).toEqual({ t: 'queued', tc: '5+3' })
    hub.handle(b, { t: 'quick', tc: '5+3' })
    expect(a.room).toMatchObject({ status: 'playing', tc: '5+3' })
    expect(a.room!.code).toBe(b.room!.code)
    expect(new Set([a.room!.you, b.room!.you])).toEqual(new Set<Color>(['red', 'black']))
  })

  it('does not pair different time controls, and cancel removes a player from the queue', () => {
    const a = player('An')
    const b = player('Binh')
    const c = player('Chi')
    for (const p of [a, b, c]) hub.connect(p)
    hub.handle(a, { t: 'quick', tc: '3+2' })
    hub.handle(b, { t: 'quick', tc: '10+5' })
    expect(a.room).toBeNull()
    expect(b.room).toBeNull()
    hub.handle(a, { t: 'cancelQuick' })
    hub.handle(c, { t: 'quick', tc: '3+2' })
    expect(c.room).toBeNull() // a left the queue, so c waits instead of pairing
  })

  it('drops a queued player who disconnects', () => {
    const a = player('An')
    const b = player('Binh')
    hub.connect(a)
    hub.connect(b)
    hub.handle(a, { t: 'quick', tc: '3+2' })
    hub.disconnect(a)
    hub.handle(b, { t: 'quick', tc: '3+2' })
    expect(b.room).toBeNull()
  })
})

describe('playing', () => {
  it('applies legal moves for the side to move and broadcasts both views', () => {
    const { red, black } = startedGame()
    hub.handle(red, { t: 'move', ...RED_OPEN })
    expect(black.room).toMatchObject({ turn: 'black', moveCount: 1, lastMove: RED_OPEN })
    expect(red.room!.fen).toBe(black.room!.fen)
    hub.handle(black, { t: 'move', ...BLACK_OPEN })
    expect(red.room).toMatchObject({ turn: 'red', moveCount: 2 })
  })

  it('rejects out-of-turn and illegal moves, and resyncs the sender', () => {
    const { red, black } = startedGame()
    hub.handle(black, { t: 'move', ...BLACK_OPEN })
    expect(black.lastError).toBe('not_your_turn')
    expect(black.msgs.at(-1)).toMatchObject({ t: 'room' })
    hub.handle(red, { t: 'move', ...E(9, 0, 5, 0) })
    expect(red.lastError).toBe('illegal')
    expect(red.room!.moveCount).toBe(0)
  })

  it('counts the clock down only for the side to move and ends the game on time', () => {
    const { red, black } = startedGame('3+2')
    vi.advanceTimersByTime(1_000)
    hub.handle(red, { t: 'move', ...RED_OPEN })
    expect(black.room!.clocks.red).toBe(180_000 - 1_000 + 2_000)
    vi.advanceTimersByTime(180_010) // black's 3:00 runs out (the flag timer adds a 5ms margin)
    expect(red.room).toMatchObject({ status: 'finished', result: { winner: 'red', reason: 'timeout' } })
    expect(saved).toHaveLength(1)
    expect(saved[0]).toMatchObject({ result: { winner: 'red', reason: 'timeout' }, moves: 'b2e2' })
  })

  it('resign finishes the game, saves it once, and records both names', () => {
    const { red, black } = startedGame()
    hub.handle(red, { t: 'move', ...RED_OPEN })
    hub.handle(black, { t: 'resign' })
    expect(red.room!.result).toEqual({ winner: 'red', reason: 'resign' })
    hub.handle(black, { t: 'resign' }) // no double-save
    expect(saved).toHaveLength(1)
    expect(saved[0]).toMatchObject({ redName: 'An', blackName: 'Binh', redUserId: null })
  })

  it('handles draw offers end to end', () => {
    const { red, black } = startedGame()
    hub.handle(red, { t: 'draw', action: 'offer' })
    expect(red.lastError).toBe('draw_unavailable') // too early
    hub.handle(red, { t: 'move', ...RED_OPEN })
    hub.handle(black, { t: 'move', ...BLACK_OPEN })
    hub.handle(red, { t: 'draw', action: 'offer' })
    expect(black.room!.drawOffer).toBe('red')
    hub.handle(black, { t: 'draw', action: 'accept' })
    expect(red.room!.result).toEqual({ winner: null, reason: 'agreement' })
  })

  it('does not let a player leave a game in progress', () => {
    const { red } = startedGame()
    hub.handle(red, { t: 'leave' })
    expect(red.lastError).toBe('game_in_progress')
  })

  it('saves the account ids of signed-in players', () => {
    const a = player('An', 'uuid-a')
    const b = player('Binh')
    hub.connect(a)
    hub.connect(b)
    hub.handle(a, { t: 'create', color: 'red', tc: '3+2' })
    hub.handle(b, { t: 'join', code: a.room!.code })
    hub.handle(b, { t: 'resign' })
    expect(saved[0]).toMatchObject({ redUserId: 'uuid-a', blackUserId: null })
  })
})

describe('connections', () => {
  it('shows the opponent as offline and restores the room on reconnect', () => {
    const { red, black } = startedGame()
    hub.handle(red, { t: 'move', ...RED_OPEN })
    hub.disconnect(black)
    expect(red.room!.black).toMatchObject({ online: false })

    const back = new FakeConn(black.identity)
    hub.connect(back)
    const welcome = back.msgs[0]
    expect(welcome).toMatchObject({ t: 'welcome', name: 'Binh', room: { status: 'playing', you: 'black', moveCount: 1 } })
    expect(red.room!.black).toMatchObject({ online: true })

    vi.advanceTimersByTime(120_000) // the abandon timer must have been cancelled
    expect(red.room!.status).toBe('playing')
  })

  it('forfeits a player who stays disconnected too long', () => {
    const { red, black } = startedGame('30+0')
    hub.disconnect(black)
    vi.advanceTimersByTime(89_000)
    expect(red.room!.status).toBe('playing')
    vi.advanceTimersByTime(2_000)
    expect(red.room).toMatchObject({ status: 'finished', result: { winner: 'red', reason: 'abandoned' } })
    expect(saved).toHaveLength(1)
  })

  it('forfeits immediately-armed when a game starts against an offline owner', () => {
    const a = player('An')
    const b = player('Binh')
    hub.connect(a)
    hub.connect(b)
    hub.handle(a, { t: 'create', color: 'red', tc: '30+0' })
    const code = a.room!.code
    hub.disconnect(a)
    hub.handle(b, { t: 'join', code })
    vi.advanceTimersByTime(91_000)
    expect(b.room).toMatchObject({ status: 'finished', result: { winner: 'black', reason: 'abandoned' } })
  })

  it('a newer connection replaces the old one without disturbing the game', () => {
    const { red } = startedGame()
    const tab2 = new FakeConn(red.identity)
    hub.connect(tab2)
    expect(red.closed).toEqual({ code: 4000, reason: expect.any(String) })
    hub.disconnect(red) // the old socket's close event arrives late
    expect(tab2.room).toMatchObject({ status: 'playing', you: 'red' })
    hub.handle(tab2, { t: 'move', ...RED_OPEN })
    expect(tab2.room!.moveCount).toBe(1)
  })

  it('keeps a finished room readable until it expires, then forgets it', () => {
    const { red } = startedGame()
    hub.handle(red, { t: 'resign' })
    vi.advanceTimersByTime(10 * 60_000 + 1)
    expect(hub.roomCount).toBe(0)
    hub.handle(red, { t: 'resign' })
    expect(red.lastError).toBe('no_room')
  })
})
