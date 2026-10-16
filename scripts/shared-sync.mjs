// `shared/` is vendored in both xiangqi-server and xiangqi-client. The server repo is the source of truth
// (it owns the protocol); the client carries a copy. This keeps the two from drifting apart.
//
//   node scripts/shared-sync.mjs check <other-shared-dir>   exit 1 if the copies differ
//   node scripts/shared-sync.mjs copy  <other-shared-dir>   overwrite <other> with this repo's shared/
import { createHash } from 'node:crypto'
import { cpSync, existsSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Sorted [relative path, sha256] for every file under `dir` (node_modules ignored). */
export function fingerprint(dir) {
  const out = []
  const walk = (d) => {
    for (const name of readdirSync(d).sort()) {
      if (name === 'node_modules') continue
      const p = join(d, name)
      if (statSync(p).isDirectory()) walk(p)
      else out.push([relative(dir, p), createHash('sha256').update(readFileSync(p)).digest('hex')])
    }
  }
  walk(dir)
  return out
}

/** Human-readable list of differences between two shared/ directories; empty when identical. */
export function diff(a, b) {
  const fa = new Map(fingerprint(a))
  const fb = new Map(fingerprint(b))
  const problems = []
  for (const [f, h] of fa) {
    if (!fb.has(f)) problems.push(`only in ${a}: ${f}`)
    else if (fb.get(f) !== h) problems.push(`differs: ${f}`)
  }
  for (const f of fb.keys()) if (!fa.has(f)) problems.push(`only in ${b}: ${f}`)
  return problems
}

export function copyShared(from, to) {
  rmSync(to, { recursive: true, force: true })
  cpSync(from, to, { recursive: true, filter: (src) => !src.split('/').includes('node_modules') })
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [mode, other] = process.argv.slice(2)
  const mine = resolve('shared')
  if (!['check', 'copy'].includes(mode) || !other) {
    console.error('usage: shared-sync.mjs <check|copy> <other-shared-dir>')
    process.exit(2)
  }
  const target = resolve(other)
  if (mode === 'copy') {
    copyShared(mine, target)
    console.log(`copied ${mine} -> ${target}`)
  } else {
    if (!existsSync(target)) {
      console.error(`${target} not found; clone the other repo next to this one to compare`)
      process.exit(2)
    }
    const problems = diff(mine, target)
    if (problems.length) {
      console.error(`shared/ has drifted:\n  ${problems.join('\n  ')}`)
      process.exit(1)
    }
    console.log('shared/ is identical in both repos')
  }
}
