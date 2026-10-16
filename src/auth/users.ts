import type { Db } from '../db/pool'

export interface User {
  id: string
  name: string
  picture: string | null
}

export interface GoogleIdentity {
  sub: string
  email: string | null
  name: string
  picture: string | null
}

export async function upsertGoogleUser(db: Db, g: GoogleIdentity): Promise<User> {
  const { rows } = await db.query<User>(
    `INSERT INTO users (google_sub, email, name, picture)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (google_sub) DO UPDATE
       SET email = EXCLUDED.email, name = EXCLUDED.name, picture = EXCLUDED.picture, last_login_at = now()
     RETURNING id, name, picture`,
    [g.sub, g.email, g.name, g.picture],
  )
  return rows[0]
}
