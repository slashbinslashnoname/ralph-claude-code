import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { resolve } from 'path'
import { createNativeRequire, NATIVE_MODULES } from './nativeRequire'

describe('createNativeRequire', () => {
  it('returns a working require function with default args', () => {
    const req = createNativeRequire()
    expect(typeof req).toBe('function')
    expect(req.resolve('fs')).toBeTruthy()
  })

  it('uses import.meta.url when it is valid', () => {
    // Pass a valid file:// URL — should succeed on the first try
    const req = createNativeRequire(import.meta.url, __filename)
    expect(typeof req).toBe('function')
    expect(req.resolve('fs')).toBeTruthy()
  })

  it('falls back to fallbackPath when metaUrl is an unsupported protocol', () => {
    // Simulate an asar:// protocol that createRequire cannot handle
    const req = createNativeRequire('asar:///app/out/main/index.js', __filename)
    expect(typeof req).toBe('function')
    expect(req.resolve('fs')).toBeTruthy()
  })

  it('falls back to fallbackPath when metaUrl is undefined', () => {
    const req = createNativeRequire(undefined, __filename)
    expect(typeof req).toBe('function')
    expect(req.resolve('fs')).toBeTruthy()
  })

  it('falls back to fallbackPath when metaUrl is empty string', () => {
    const req = createNativeRequire('', __filename)
    expect(typeof req).toBe('function')
    expect(req.resolve('fs')).toBeTruthy()
  })

  it('exports NATIVE_MODULES list', () => {
    expect(NATIVE_MODULES).toContain('node-pty')
    expect(NATIVE_MODULES).toContain('fsevents')
  })
})

describe('asarUnpack covers all known native modules', () => {
  const ROOT = resolve(__dirname, '../..')
  const builderConfig = readFileSync(resolve(ROOT, 'electron-builder.yml'), 'utf-8')

  it('every NATIVE_MODULES entry has a corresponding asarUnpack glob', () => {
    for (const mod of NATIVE_MODULES) {
      expect(
        builderConfig,
        `Missing asarUnpack entry for native module: ${mod}`,
      ).toContain(`node_modules/${mod}/**/*`)
    }
  })

  it('chokidar does not need asarUnpack (pure JS, fsevents is separate)', () => {
    // chokidar itself is pure JS; only its optional dep fsevents needs unpacking
    expect(builderConfig).not.toContain('node_modules/chokidar/**/*')
    expect(builderConfig).toContain('node_modules/fsevents/**/*')
  })
})
