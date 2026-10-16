import type { GameRecord } from '../online/hub'
import type { Db } from './pool'

export async function insertGame(db: Db, g: GameRecord): Promise<void> {
  await db.query(
    `INSERT INTO games (code, tc, red_name, black_name, red_user_id, black_user_id, winner, reason, moves, started_at, finished_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [g.code, g.tc, g.redName, g.blackName, g.redUserId, g.blackUserId, g.result.winner, g.result.reason, g.moves, g.startedAt, g.finishedAt],
  )
}
