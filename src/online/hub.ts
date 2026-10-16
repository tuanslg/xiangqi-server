import { randomInt } from 'node:crypto'
import { TIME_CONTROLS, moveToUci, toFen } from '@xiangqi/shared'
import type { ClientMessage, Color, GameResult, RoomSnapshot, ServerMessage, TimeControlId } from '@xiangqi/shared'
import { XqGame } from './game'

export interface Identity {
  /** Stable id: `u:<user uuid>` for accounts, `g:<guest id>` for guests. */
  key: string
  name: string
  userId: string | null
}

export interface Conn {
  identity: Identity
  send(msg: ServerMessage): void
  close(code: number, reason: string): void
}

export interface GameRecord {
  code: string
  tc: TimeControlId
  redName: string
  blackName: string
  redUserId: string | null
  blackUserId: string | null
  result: GameResult
  moves: string
  startedAt: Date
  finishedAt: Date
}

export interface HubOptions {
  saveGame?: (record: GameRecord) => Promise<void>
  onError?: (err: unknown, what: string) => void
  maxRooms?: number
  /** How long a disconnected player has to come back before forfeiting. */
  abandonMs?: number
  /** How long a room waiting for an opponent stays open. */
  waitingMs?: number
  /** How long a finished room stays so players can read the result. */
  finishedMs?: number
}

interface Seat {
  identity: Identity
  conn: Conn | null
}

interface Room {
  code: string
  tc: TimeControlId
  status: 'waiting' | 'playing' | 'finished'
  game: XqGame
  seats: Record<Color, Seat | null>
  startedAt: Date | null
  flagTimer?: NodeJS.Timeout
  abandonTimers: Partial<Record<Color, NodeJS.Timeout>>
  expiryTimer?: NodeJS.Timeout
}

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789' // no I, O, 0, 1

const err = (code: string, message: string): ServerMessage => ({ t: 'error', code, message })

/** In-memory rooms, matchmaking and clocks for online games. All I/O goes through `Conn`. */
export class Hub {
  private readonly rooms = new Map<string, Room>()
  private readonly roomOf = new Map<string, string>() // player key -> room code
  private readonly conns = new Map<string, Conn>()
  private readonly queue: { tc: TimeControlId; identity: Identity }[] = []
  private readonly opts: Required<Omit<HubOptions, 'saveGame' | 'onError'>> & Pick<HubOptions, 'saveGame' | 'onError'>

  constructor(opts: HubOptions = {}) {
    this.opts = {
      maxRooms: 5_000,
      abandonMs: 90_000,
      waitingMs: 15 * 60_000,
      finishedMs: 10 * 60_000,
      ...opts,
    }
  }

  get roomCount(): number {
    return this.rooms.size
  }

  connect(conn: Conn): void {
    const { key } = conn.identity
    const old = this.conns.get(key)
    this.conns.set(key, conn)
    if (old && old !== conn) old.close(4000, 'replaced by a newer connection')

    const room = this.roomFor(key)
    if (room) {
      const color = this.colorOf(room, key)!
      room.seats[color]!.conn = conn
      clearTimeout(room.abandonTimers[color])
      this.broadcast(room, conn)
    }
    conn.send({
      t: 'welcome',
      name: conn.identity.name,
      signedIn: conn.identity.userId !== null,
      room: room ? this.snapshot(room, this.colorOf(room, key)!) : null,
    })
  }

  disconnect(conn: Conn): void {
    const { key } = conn.identity
    if (this.conns.get(key) !== conn) return // already superseded by a newer connection
    this.conns.delete(key)
    const q = this.queue.findIndex((e) => e.identity.key === key)
    if (q >= 0) this.queue.splice(q, 1)

    const room = this.roomFor(key)
    if (!room) return
    const color = this.colorOf(room, key)!
    room.seats[color]!.conn = null
    if (room.status === 'playing') this.armAbandon(room, color)
    this.broadcast(room)
  }

  handle(conn: Conn, msg: ClientMessage): void {
    switch (msg.t) {
      case 'ping':
        return conn.send({ t: 'pong' })
      case 'create':
        return this.create(conn, msg.color, msg.tc)
      case 'join':
        return this.join(conn, msg.code)
      case 'quick':
        return this.quick(conn, msg.tc)
      case 'cancelQuick': {
        const i = this.queue.findIndex((e) => e.identity.key === conn.identity.key)
        if (i >= 0) this.queue.splice(i, 1)
        return conn.send({ t: 'dequeued' })
      }
      case 'move':
        return this.move(conn, msg)
      case 'resign':
        return this.act(conn, (room, color) => {
          if (room.game.resign(color)) this.finish(room)
        })
      case 'draw':
        return this.draw(conn, msg.action)
      case 'leave':
        return this.leave(conn)
    }
  }

  /** Stops all timers; for tests and graceful shutdown. */
  close(): void {
    for (const room of this.rooms.values()) this.clearTimers(room)
    this.rooms.clear()
    this.roomOf.clear()
    this.conns.clear()
    this.queue.length = 0
  }

  // ---- commands -----------------------------------------------------------------------------

  private create(conn: Conn, choice: Color | 'random', tc: TimeControlId): void {
    if (!this.ensureFree(conn)) return
    const color: Color = choice === 'random' ? (randomInt(2) === 0 ? 'red' : 'black') : choice
    const room = this.newRoom(tc)
    if (!room) return conn.send(err('server_full', 'Máy chủ đang quá tải, vui lòng thử lại sau.'))
    this.seat(room, color, conn.identity, conn)
    room.expiryTimer = setTimeout(() => this.expire(room, 'Phòng đã hết hạn chờ đối thủ.'), this.opts.waitingMs)
    this.broadcast(room)
  }

  private join(conn: Conn, code: string): void {
    if (!this.ensureFree(conn)) return
    const room = this.rooms.get(code)
    if (!room) return conn.send(err('room_not_found', 'Không tìm thấy phòng với mã này.'))
    const free = (['red', 'black'] as const).find((c) => room.seats[c] === null)
    if (room.status !== 'waiting' || !free) return conn.send(err('room_full', 'Phòng này đã đủ người.'))
    this.seat(room, free, conn.identity, conn)
    this.startGame(room)
  }

  private quick(conn: Conn, tc: TimeControlId): void {
    if (!this.ensureFree(conn)) return
    if (this.queue.some((e) => e.identity.key === conn.identity.key)) return conn.send({ t: 'queued', tc })
    const i = this.queue.findIndex((e) => e.tc === tc)
    if (i < 0) {
      this.queue.push({ tc, identity: conn.identity })
      return conn.send({ t: 'queued', tc })
    }
    const [opponent] = this.queue.splice(i, 1)
    const theirConn = this.conns.get(opponent.identity.key)
    if (!theirConn) return this.quick(conn, tc) // stale entry; try again with the rest of the queue
    const room = this.newRoom(tc)
    if (!room) return conn.send(err('server_full', 'Máy chủ đang quá tải, vui lòng thử lại sau.'))
    const mineRed = randomInt(2) === 0
    this.seat(room, mineRed ? 'red' : 'black', conn.identity, conn)
    this.seat(room, mineRed ? 'black' : 'red', opponent.identity, theirConn)
    this.startGame(room)
  }

  private move(conn: Conn, msg: Extract<ClientMessage, { t: 'move' }>): void {
    this.act(conn, (room, color) => {
      if (room.status !== 'playing') return conn.send(err('not_playing', 'Ván đấu chưa bắt đầu hoặc đã kết thúc.'))
      const out = room.game.playMove(color, { from: msg.from, to: msg.to }, Date.now())
      if (!out.ok) {
        if (out.reason === 'timeout') return this.finish(room)
        conn.send(err(out.reason, 'Nước đi không hợp lệ.'))
        return conn.send({ t: 'room', room: this.snapshot(room, color) }) // resync the client
      }
      if (room.game.result) this.finish(room)
      else {
        this.armFlag(room)
        this.broadcast(room)
      }
    })
  }

  private draw(conn: Conn, action: 'offer' | 'accept' | 'decline'): void {
    this.act(conn, (room, color) => {
      if (room.status !== 'playing') return conn.send(err('not_playing', 'Ván đấu chưa bắt đầu hoặc đã kết thúc.'))
      const g = room.game
      const ok = action === 'offer' ? g.offerDraw(color) : action === 'accept' ? g.acceptDraw(color) : g.declineDraw(color)
      if (!ok) return conn.send(err('draw_unavailable', 'Không thể thực hiện yêu cầu hòa lúc này.'))
      if (g.result) this.finish(room)
      else this.broadcast(room)
    })
  }

  private leave(conn: Conn): void {
    const room = this.roomFor(conn.identity.key)
    if (!room) return conn.send({ t: 'left' })
    if (room.status === 'playing')
      return conn.send(err('game_in_progress', 'Hãy đầu hàng nếu muốn rời ván đang chơi.'))
    this.removePlayer(room, conn.identity.key)
    conn.send({ t: 'left' })
  }

  // ---- internals ----------------------------------------------------------------------------

  /** Runs `fn` with the caller's room and colour, or replies with an error if they have none. */
  private act(conn: Conn, fn: (room: Room, color: Color) => void): void {
    const room = this.roomFor(conn.identity.key)
    if (!room) return conn.send(err('no_room', 'Bạn chưa ở trong phòng nào.'))
    fn(room, this.colorOf(room, conn.identity.key)!)
  }

  /** A player may hold one live room. A finished one is released automatically; a live one blocks. */
  private ensureFree(conn: Conn): boolean {
    const room = this.roomFor(conn.identity.key)
    if (!room) return true
    if (room.status === 'finished') {
      this.removePlayer(room, conn.identity.key)
      return true
    }
    conn.send(err('already_in_room', 'Bạn đang ở trong một phòng khác.'))
    return false
  }

  private newRoom(tc: TimeControlId): Room | null {
    if (this.rooms.size >= this.opts.maxRooms) return null
    let code: string
    do code = Array.from({ length: 6 }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join('')
    while (this.rooms.has(code))
    const { baseMs, incMs } = TIME_CONTROLS[tc]
    const room: Room = {
      code, tc, status: 'waiting', game: new XqGame(baseMs, incMs),
      seats: { red: null, black: null }, startedAt: null, abandonTimers: {},
    }
    this.rooms.set(code, room)
    return room
  }

  private seat(room: Room, color: Color, identity: Identity, conn: Conn): void {
    room.seats[color] = { identity, conn }
    this.roomOf.set(identity.key, room.code)
  }

  private startGame(room: Room): void {
    clearTimeout(room.expiryTimer)
    room.status = 'playing'
    room.startedAt = new Date()
    room.game.start(Date.now())
    this.armFlag(room)
    for (const c of ['red', 'black'] as const) if (!room.seats[c]!.conn) this.armAbandon(room, c)
    this.broadcast(room)
  }

  private armFlag(room: Room): void {
    clearTimeout(room.flagTimer)
    if (room.status !== 'playing') return
    const ms = room.game.remaining(room.game.turn, Date.now())
    room.flagTimer = setTimeout(() => {
      if (room.status !== 'playing') return
      if (room.game.flag(Date.now())) this.finish(room)
      else this.armFlag(room) // fired a hair early
    }, ms + 5)
  }

  private armAbandon(room: Room, color: Color): void {
    clearTimeout(room.abandonTimers[color])
    room.abandonTimers[color] = setTimeout(() => {
      if (room.status !== 'playing' || room.seats[color]?.conn) return
      room.game.abandon(color)
      this.finish(room)
    }, this.opts.abandonMs)
  }

  private finish(room: Room): void {
    if (room.status === 'finished') return
    room.status = 'finished'
    this.clearTimers(room)
    const result = room.game.result
    if (result && room.startedAt) this.save(room, result)
    room.expiryTimer = setTimeout(() => this.expire(room), this.opts.finishedMs)
    this.broadcast(room)
  }

  private save(room: Room, result: GameResult): void {
    const { red, black } = room.seats
    const record: GameRecord = {
      code: room.code,
      tc: room.tc,
      redName: red!.identity.name,
      blackName: black!.identity.name,
      redUserId: red!.identity.userId,
      blackUserId: black!.identity.userId,
      result,
      moves: room.game.moves.map(moveToUci).join(' '),
      startedAt: room.startedAt!,
      finishedAt: new Date(),
    }
    this.opts.saveGame?.(record).catch((e) => this.opts.onError?.(e, 'saveGame'))
  }

  /** Drops the room; if `reason` is given, connected players are told they were removed. */
  private expire(room: Room, reason?: string): void {
    for (const c of ['red', 'black'] as const) {
      const seat = room.seats[c]
      if (!seat) continue
      this.roomOf.delete(seat.identity.key)
      if (reason) seat.conn?.send(err('room_expired', reason))
      if (reason) seat.conn?.send({ t: 'left' })
    }
    this.clearTimers(room)
    this.rooms.delete(room.code)
  }

  private removePlayer(room: Room, key: string): void {
    const color = this.colorOf(room, key)!
    room.seats[color] = null
    this.roomOf.delete(key)
    if (!room.seats.red && !room.seats.black) {
      this.clearTimers(room)
      this.rooms.delete(room.code)
    } else this.broadcast(room)
  }

  private clearTimers(room: Room): void {
    clearTimeout(room.flagTimer)
    clearTimeout(room.expiryTimer)
    clearTimeout(room.abandonTimers.red)
    clearTimeout(room.abandonTimers.black)
  }

  private roomFor(key: string): Room | undefined {
    const code = this.roomOf.get(key)
    return code ? this.rooms.get(code) : undefined
  }

  private colorOf(room: Room, key: string): Color | null {
    return (['red', 'black'] as const).find((c) => room.seats[c]?.identity.key === key) ?? null
  }

  /** Sends each seated player their own view of the room (`you` differs per seat). */
  private broadcast(room: Room, skip?: Conn): void {
    for (const c of ['red', 'black'] as const) {
      const conn = room.seats[c]?.conn
      if (conn && conn !== skip) conn.send({ t: 'room', room: this.snapshot(room, c) })
    }
  }

  private snapshot(room: Room, you: Color): RoomSnapshot {
    const now = Date.now()
    const g = room.game
    const info = (c: Color) => (room.seats[c] ? { name: room.seats[c]!.identity.name, online: room.seats[c]!.conn !== null } : null)
    return {
      code: room.code,
      tc: room.tc,
      status: room.status,
      fen: toFen({ board: g.board, turn: g.turn }),
      turn: g.turn,
      you,
      red: info('red'),
      black: info('black'),
      lastMove: g.lastMove,
      moveCount: g.moves.length,
      clocks: { red: g.remaining('red', now), black: g.remaining('black', now), serverTime: now },
      drawOffer: g.drawOffer,
      result: g.result,
    }
  }
}

