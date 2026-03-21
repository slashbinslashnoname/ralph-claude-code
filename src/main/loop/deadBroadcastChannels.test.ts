import { describe, it, expect } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'

/**
 * Regression tests: dead broadcast channels must not exist in ipc.ts.
 *
 * ipc.ts depends on Electron and cannot be imported directly, so we
 * verify at the source level that removed channels stay removed.
 */

const ipcSource = fs.readFileSync(
  path.resolve(__dirname, '../ipc.ts'),
  'utf-8',
)

describe('dead broadcast channels removed from ipc.ts', () => {
  it('does not broadcast pty:data (removed — no consumer)', () => {
    expect(ipcSource).not.toContain("broadcast('pty:data'")
  })

  it('does not broadcast progress:update (removed — no consumer)', () => {
    expect(ipcSource).not.toContain("broadcast('progress:update'")
  })

  it('does not broadcast analysis:update (removed — no consumer)', () => {
    expect(ipcSource).not.toContain("broadcast('analysis:update'")
  })
})
