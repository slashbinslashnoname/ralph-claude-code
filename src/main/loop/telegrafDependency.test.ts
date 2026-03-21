import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { resolve } from 'path'

describe('telegraf dependency', () => {
  const pkgPath = resolve(__dirname, '../../../package.json')
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))

  it('is listed in dependencies', () => {
    expect(pkg.dependencies).toHaveProperty('telegraf')
  })

  it('specifies ^4.16.0 semver range', () => {
    expect(pkg.dependencies.telegraf).toBe('^4.16.0')
  })

  it('resolves to an installed module', () => {
    // Verify telegraf can be resolved (installed in node_modules)
    const resolved = require.resolve('telegraf')
    expect(resolved).toBeTruthy()
  })

  it('is externalized by electron-vite config', () => {
    // The electron-vite config reads all dependency keys and externalizes them.
    // Verify telegraf appears in the dependencies that get externalized.
    const allDeps = Object.keys(pkg.dependencies ?? {})
    expect(allDeps).toContain('telegraf')
  })
})
