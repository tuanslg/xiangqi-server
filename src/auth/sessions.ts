import { createHash, randomBytes } from 'node:crypto'
import type { Db } from '../db/pool'
import type { User } from './users'

export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000
export const SESSION_COOKIE = 'sid'

const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/ // 32 random bytes, base64url

const hash = (token: string) => createHash('sha256').update(token).digest()

export async function createSession(db: Db, userId: string): Promise<{ token: string; expiresAt: Date }> {
  const token = randomBytes(32).toString('base64url')
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS)
  await db.query('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES ($1, $2, $3)', [hash(token), userId, expiresAt])
  // Opportunistic cleanup keeps the table small without a scheduler.
  void db.query('DELETE FROM sessions WHERE expires_at < now()').catch(() => {})
  return { token, expiresAt }
}

export async function findSessionUser(db: Db, token: string | undefined): Promise<User | null> {
  if (!token || !TOKEN_RE.test(token)) return null
  const { rows } = await db.query<User>(
    `SELECT u.id, u.name, u.picture
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = $1 AND s.expires_at > now()`,
    [hash(token)],
  )
  return rows[0] ?? null
}

export async function deleteSession(db: Db, token: string | undefined): Promise<void> {
  if (!token || !TOKEN_RE.test(token)) return
  await db.query('DELETE FROM sessions WHERE token_hash = $1', [hash(token)])
}
