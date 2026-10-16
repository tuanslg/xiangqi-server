import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { upsertGoogleUser } from '../auth/users'
import { Hub } from '../online/hub'
import type { Conn, GameRecord } from '../online/hub'
import { insertGame } from './games'
import { migrate } from './migrate'
import { createPool } from './pool'
import type { Db } from './pool'

const url = process.env.TEST_DATABASE_URL
if (url && !/_test(\?|$)/.test(url)) throw new Error('TEST_DATABASE_URL must point at a database whose name ends in _test (it gets wiped)')

describe.skipIf(!url)('game persistence (Postgres)', () => {
  let db: Db
  beforeAll(async () => {
    db = createPool(url!)
    await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public')
    await migrate(db)
  })
  afterAll(() => db.end())

  const record = (over: Partial<GameRecord> = {}): GameRecord => ({
    code: 'ABC234', tc: '3+2', redName: 'An', blackName: 'Binh', redUserId: null, blackUserId: null,
    result: { winner: 'red', reason: 'resign' }, moves: 'h2e2 h9g7',
    startedAt: new Date('2026-01-01T10:00:00Z'), finishedAt: new Date('2026-01-01T10:05:00Z'), ...over,
  })

  it('stores a finished game, including draws as NULL winner', async () => {
    await insertGame(db, record())
    await insertGame(db, record({ result: { winner: null, reason: 'agreement' } }))
    const { rows } = await db.query('SELECT winner, reason, moves FROM games ORDER BY reason')
    expect(rows).toEqual([
      { winner: null, reason: 'agreement', moves: 'h2e2 h9g7' },
      { winner: 'red', reason: 'resign', moves: 'h2e2 h9g7' },
    ])
  })

  it('links accounts and keeps the game when the account is deleted', async () => {
    const user = await upsertGoogleUser(db, { sub: 's1', email: null, name: 'An', picture: null })
    await insertGame(db, record({ redUserId: user.id, code: 'LINKED' }))
    await db.query('DELETE FROM users WHERE id = $1', [user.id])
    const { rows } = await db.query("SELECT red_user_id, red_name FROM games WHERE code = 'LINKED'")
    expect(rows).toEqual([{ red_user_id: null, red_name: 'An' }])
  })

  it('the Hub persists a game when it finishes', async () => {
    const saved: Promise<void>[] = []
    const hub = new Hub({ saveGame: (r) => { const p = insertGame(db, r); saved.push(p); return p } })
    const mk = (n: string): Conn & { room?: string } => ({
      identity: { key: `g:${n}`, name: n, userId: null },
      send(m) { if (m.t === 'room') this.room = m.room.code },
      close() {},
    })
    const a = mk('Hub-An')
    const b = mk('Hub-Binh')
    hub.connect(a)
    hub.connect(b)
    hub.handle(a, { t: 'create', color: 'red', tc: '5+3' })
    hub.handle(b, { t: 'join', code: a.room! })
    hub.handle(a, { t: 'move', from: { row: 7, col: 1 }, to: { row: 7, col: 4 } })
    hub.handle(b, { t: 'resign' })
    await Promise.all(saved)
    hub.close()
    const { rows } = await db.query("SELECT red_name, black_name, winner, reason, moves, tc FROM games WHERE red_name = 'Hub-An'")
    expect(rows).toEqual([{ red_name: 'Hub-An', black_name: 'Hub-Binh', winner: 'red', reason: 'resign', moves: 'b2e2', tc: '5+3' }])
  })
})
