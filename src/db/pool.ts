import pg from 'pg'

export type Db = pg.Pool

export function createPool(connectionString: string): Db {
  const pool = new pg.Pool({ connectionString, max: 10, idleTimeoutMillis: 30_000, connectionTimeoutMillis: 5_000 })
  // An idle client dying (e.g. DB restart) must not crash the process; the pool replaces it.
  pool.on('error', (err) => console.error('postgres pool error:', err.message))
  return pool
}
