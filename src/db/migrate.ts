import { readFile, readdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { serverRoot } from '../config'
import type { Db } from './pool'

const defaultDir = resolve(serverRoot, 'migrations')
/** Arbitrary constant: serialises concurrent migrators (e.g. two containers booting together). */
const LOCK_ID = 7_428_001

/** Applies pending `NNN_name.sql` files in order, each in its own transaction. Returns the names applied. */
export async function migrate(db: Db, dir: string = defaultDir): Promise<string[]> {
  const client = await db.connect()
  const applied: string[] = []
  try {
    await client.query('SELECT pg_advisory_lock($1)', [LOCK_ID])
    await client.query(
      'CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())',
    )
    const done = new Set((await client.query<{ name: string }>('SELECT name FROM schema_migrations')).rows.map((r) => r.name))
    const files = (await readdir(dir)).filter((f) => /^\d+_.+\.sql$/.test(f)).sort()
    for (const file of files) {
      if (done.has(file)) continue
      const sql = await readFile(resolve(dir, file), 'utf8')
      try {
        await client.query('BEGIN')
        await client.query(sql)
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file])
        await client.query('COMMIT')
      } catch (err) {
        await client.query('ROLLBACK')
        throw new Error(`migration ${file} failed: ${err instanceof Error ? err.message : String(err)}`)
      }
      applied.push(file)
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [LOCK_ID]).catch(() => {})
    client.release()
  }
  return applied
}
