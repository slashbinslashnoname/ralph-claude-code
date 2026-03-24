import { describe, test, expect, vi, beforeEach } from 'vitest'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { readFileSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const src = readFileSync(resolve(__dirname, 'UpdateBanner.tsx'), 'utf-8')

describe('UpdateBanner source analysis', () => {
  test('imports UpdateState, UpdateInfo, UpdateProgress from types', () => {
    expect(src).toContain("import type { UpdateState, UpdateInfo, UpdateProgress } from '../types/ipc'")
  })

  test('defines BannerState interface with required fields', () => {
    expect(src).toContain('phase: UpdateState')
    expect(src).toContain('info: UpdateInfo | null')
    expect(src).toContain('progress: UpdateProgress | null')
    expect(src).toContain('error: string | null')
    expect(src).toContain('installing: boolean')
  })

  test('calls getState() on mount for hydration', () => {
    expect(src).toContain('sb.update.getState()')
  })

  test('subscribes to all six update events', () => {
    expect(src).toContain('sb.update.onChecking(')
    expect(src).toContain('sb.update.onAvailable(')
    expect(src).toContain('sb.update.onNotAvailable(')
    expect(src).toContain('sb.update.onProgress(')
    expect(src).toContain('sb.update.onDownloaded(')
    expect(src).toContain('sb.update.onError(')
  })

  test('unsubscribes on unmount', () => {
    expect(src).toContain('unsubs.forEach(u => u())')
  })

  test('returns null for idle and not-available phases', () => {
    expect(src).toContain("state.phase === 'idle'")
    expect(src).toContain("state.phase === 'not-available'")
    expect(src).toMatch(/if\s*\(state\.phase === 'idle' \|\| state\.phase === 'not-available'\)\s*return null/)
  })

  test('renders checking state with spinner', () => {
    expect(src).toContain("state.phase === 'checking'")
    expect(src).toContain('update-spinner')
    expect(src).toContain('Checking for updates')
  })

  test('renders available state with version and download button', () => {
    expect(src).toContain("state.phase === 'available'")
    expect(src).toContain('state.info?.version')
    expect(src).toContain('onClick={handleDownload}')
    expect(src).toContain('Download')
  })

  test('renders downloading state with progress bar and speed', () => {
    expect(src).toContain("state.phase === 'downloading'")
    expect(src).toContain('update-progress-bar')
    expect(src).toContain('update-progress-fill')
    expect(src).toContain('state.progress.percent')
    expect(src).toContain('formatSpeed')
    expect(src).toContain("'Downloading…'")
  })

  test('renders downloaded state with restart button', () => {
    expect(src).toContain("state.phase === 'downloaded'")
    expect(src).toContain('onClick={handleInstall}')
    expect(src).toContain('Restart & Install')
  })

  test('restart button shows loading state while installing', () => {
    expect(src).toContain('disabled={state.installing}')
    expect(src).toContain("state.installing ? 'Restarting…' : 'Restart & Install'")
  })

  test('renders error state with message and dismiss button', () => {
    expect(src).toContain("state.phase === 'error'")
    expect(src).toContain('state.error')
    expect(src).toContain('onClick={handleDismiss}')
    expect(src).toContain('Dismiss')
  })

  test('calls sb.update.download on download click', () => {
    expect(src).toContain('sb.update.download()')
  })

  test('calls sb.update.install on install click', () => {
    expect(src).toContain('sb.update.install()')
  })

  test('dismiss resets phase to idle', () => {
    expect(src).toMatch(/phase:\s*'idle'.*error:\s*null/)
  })

  test('has data-phase attribute for CSS targeting', () => {
    expect(src).toContain('data-phase={state.phase}')
  })

  test('uses update-banner CSS class', () => {
    expect(src).toContain('className="update-banner"')
  })
})

describe('UpdateBanner rendering', () => {
  const noop = () => () => {}

  beforeEach(() => {
    ;(globalThis as any).window = {
      slashbot: {
        update: {
          getState: vi.fn().mockResolvedValue({ state: 'idle', info: null }),
          check: vi.fn(),
          download: vi.fn(),
          install: vi.fn(),
          onChecking: vi.fn(noop),
          onAvailable: vi.fn(noop),
          onNotAvailable: vi.fn(noop),
          onProgress: vi.fn(noop),
          onDownloaded: vi.fn(noop),
          onError: vi.fn(noop),
        },
      },
    }
  })

  test('exports a default function component', async () => {
    // Dynamic import to pick up the mock
    const mod = await import('./UpdateBanner')
    expect(typeof mod.default).toBe('function')
  })
})

describe('formatSpeed helper', () => {
  test('source contains MB/s formatting', () => {
    expect(src).toContain('MB/s')
  })

  test('source contains KB/s formatting', () => {
    expect(src).toContain('KB/s')
  })

  test('source contains B/s formatting', () => {
    expect(src).toContain('B/s')
  })
})
