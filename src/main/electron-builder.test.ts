import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync } from 'fs'
import { resolve } from 'path'

const ROOT = resolve(__dirname, '../..')
const configPath = resolve(ROOT, 'electron-builder.yml')

function loadRawConfig(): string {
  return readFileSync(configPath, 'utf-8')
}

describe('electron-builder.yml', () => {
  it('exists at project root', () => {
    expect(existsSync(configPath)).toBe(true)
  })

  it('contains required top-level keys', () => {
    const raw = loadRawConfig()
    expect(raw).toContain('appId: com.slashbot.app')
    expect(raw).toContain('productName: Slashbot')
    expect(raw).toContain('asar: true')
  })

  it('has files, asarUnpack, extraResources, and platform sections', () => {
    const raw = loadRawConfig()
    expect(raw).toMatch(/^files:/m)
    expect(raw).toMatch(/^asarUnpack:/m)
    expect(raw).toMatch(/^extraResources:/m)
    expect(raw).toMatch(/^mac:/m)
    expect(raw).toMatch(/^linux:/m)
    expect(raw).toMatch(/^win:/m)
  })

  it('unpacks native modules from ASAR', () => {
    const raw = loadRawConfig()
    expect(raw).toContain('node_modules/node-pty/**/*')
    expect(raw).toContain('node_modules/fsevents/**/*')
  })

  it('includes icon.png in extraResources', () => {
    const raw = loadRawConfig()
    expect(raw).toContain('from: resources/icon.png')
    expect(raw).toContain('to: icon.png')
  })

  it('extraResources icon.png "to" path matches getIconPath expectation', () => {
    // getIconPath.ts uses: path.join(process.resourcesPath, 'icon.png')
    // electron-builder copies extraResources "to" relative to resourcesPath
    const raw = loadRawConfig()
    // Find the icon.png resource entry - "to: icon.png" means it will be at resourcesPath/icon.png
    const lines = raw.split('\n')
    const fromIdx = lines.findIndex((l) => l.includes('from: resources/icon.png'))
    expect(fromIdx).toBeGreaterThan(-1)
    const toLine = lines[fromIdx + 1]
    expect(toLine).toContain('to: icon.png')
  })

  it('outputs to dist-electron directory', () => {
    const raw = loadRawConfig()
    expect(raw).toContain('output: dist-electron')
  })

  it('packages from out/ directory (electron-vite output)', () => {
    const raw = loadRawConfig()
    expect(raw).toContain('out/**/*')
  })

  it('source icon files exist in resources/', () => {
    expect(existsSync(resolve(ROOT, 'resources/icon.png'))).toBe(true)
  })
})

describe('package.json build scripts', () => {
  const pkg = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf-8'))

  it('has pack script', () => {
    expect(pkg.scripts.pack).toContain('electron-builder --dir')
  })

  it('has dist script', () => {
    expect(pkg.scripts.dist).toContain('electron-builder')
  })

  it('has platform-specific dist scripts', () => {
    expect(pkg.scripts['dist:mac']).toContain('--mac')
    expect(pkg.scripts['dist:linux']).toContain('--linux')
    expect(pkg.scripts['dist:win']).toContain('--win')
  })

  it('all dist scripts run electron-vite build first', () => {
    expect(pkg.scripts.pack).toMatch(/^electron-vite build/)
    expect(pkg.scripts.dist).toMatch(/^electron-vite build/)
    expect(pkg.scripts['dist:mac']).toMatch(/^electron-vite build/)
    expect(pkg.scripts['dist:linux']).toMatch(/^electron-vite build/)
    expect(pkg.scripts['dist:win']).toMatch(/^electron-vite build/)
  })

  it('has electron-builder as devDependency', () => {
    expect(pkg.devDependencies['electron-builder']).toBeDefined()
  })

  it('has @electron/rebuild as devDependency', () => {
    expect(pkg.devDependencies['@electron/rebuild']).toBeDefined()
  })

  it('has electron-updater as a runtime dependency (not devDependency)', () => {
    expect(pkg.dependencies['electron-updater']).toBeDefined()
    expect(pkg.dependencies['electron-updater']).toBe('^4.6.0')
    // Must NOT be in devDependencies — it's needed at runtime for auto-update
    expect(pkg.devDependencies['electron-updater']).toBeUndefined()
  })
})

describe('electron-updater resolution', () => {
  it('resolves to a 4.6.x version', () => {
    const updaterPkg = JSON.parse(
      readFileSync(resolve(ROOT, 'node_modules/electron-updater/package.json'), 'utf-8')
    )
    expect(updaterPkg.version).toMatch(/^4\.6\./)
  })

  it('module is importable', () => {
    expect(() => require('electron-updater')).not.toThrow()
  })
})
