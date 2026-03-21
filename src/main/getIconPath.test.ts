import { describe, it, expect, vi, afterEach } from 'vitest'
import * as path from 'path'

vi.mock('electron', () => ({
  app: {
    isPackaged: false
  }
}))

import { app } from 'electron'

describe('getIconPath', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.resetModules()
  })

  it('returns resources/icon.png relative to __dirname in dev mode', async () => {
    ;(app as any).isPackaged = false
    const { getIconPath } = await import('./getIconPath')
    const result = getIconPath()
    expect(result).toContain('icon.png')
    expect(result).toContain('resources')
  })

  it('returns process.resourcesPath/icon.png when packaged', async () => {
    ;(app as any).isPackaged = true
    ;(process as any).resourcesPath = '/app/Contents/Resources'
    const { getIconPath } = await import('./getIconPath')
    const result = getIconPath()
    expect(result).toBe(path.join('/app/Contents/Resources', 'icon.png'))
    delete (process as any).resourcesPath
  })

  it('always returns a .png path, never .svg', async () => {
    ;(app as any).isPackaged = false
    const { getIconPath } = await import('./getIconPath')
    const result = getIconPath()
    expect(result).toMatch(/\.png$/)
    expect(result).not.toMatch(/\.svg/)
  })
})
