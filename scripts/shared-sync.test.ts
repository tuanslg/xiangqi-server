import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
// @ts-expect-error plain JS module without types
import { copyShared, diff } from './shared-sync.mjs'

const dirs: string[] = []
const make = (files: Record<string, string>) => {
  const d = mkdtempSync(join(tmpdir(), 'xq-shared-'))
  dirs.push(d)
  for (const [f, c] of Object.entries(files)) {
    mkdirSync(join(d, f, '..'), { recursive: true })
    writeFileSync(join(d, f), c)
  }
  return d
}
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })))

describe('shared-sync', () => {
  it('reports no difference for identical trees, ignoring node_modules', () => {
    const a = make({ 'src/a.ts': '1', 'package.json': '{}' })
    const b = make({ 'src/a.ts': '1', 'package.json': '{}', 'node_modules/x/y.js': 'junk' })
    expect(diff(a, b)).toEqual([])
  })

  it('names changed, missing and extra files', () => {
    const a = make({ 'src/a.ts': '1', 'src/only-a.ts': 'x' })
    const b = make({ 'src/a.ts': '2', 'src/only-b.ts': 'y' })
    const problems = diff(a, b).join('\n')
    expect(problems).toContain('differs: src/a.ts')
    expect(problems).toContain('src/only-a.ts')
    expect(problems).toContain('src/only-b.ts')
  })

  it('copy makes the target identical and drops stale files', () => {
    const a = make({ 'src/a.ts': 'new' })
    const b = make({ 'src/a.ts': 'old', 'src/stale.ts': 'z' })
    copyShared(a, b)
    expect(diff(a, b)).toEqual([])
  })
})
