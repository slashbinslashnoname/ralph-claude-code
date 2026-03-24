import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createRoot } from 'react-dom/client'
import { act } from 'react'

// Enable React act() environment for jsdom
;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

// Mock window.slashbot.update before importing component
const mockUpdate = {
  check: vi.fn(),
  download: vi.fn(),
  install: vi.fn(),
  getState: vi.fn().mockResolvedValue(null),
  onChecking: vi.fn(() => () => {}),
  onAvailable: vi.fn(() => () => {}),
  onNotAvailable: vi.fn(() => () => {}),
  onProgress: vi.fn(() => () => {}),
  onDownloaded: vi.fn(() => () => {}),
  onError: vi.fn(() => () => {}),
}

// Attach slashbot API to the jsdom window
;(window as any).slashbot = { update: mockUpdate }

import UpdateBanner from './UpdateBanner'

let container: HTMLDivElement | null = null

beforeEach(() => {
  vi.clearAllMocks()
  mockUpdate.getState.mockResolvedValue(null)
  container = document.createElement('div')
  document.body.appendChild(container)
})

afterEach(() => {
  if (container) {
    document.body.removeChild(container)
    container = null
  }
})

describe('UpdateBanner — static (idle)', () => {
  test('renders nothing in idle state (default)', () => {
    const html = renderToStaticMarkup(<UpdateBanner />)
    expect(html).toBe('')
  })

  test('component exports a function', () => {
    expect(typeof UpdateBanner).toBe('function')
  })
})

describe('UpdateBanner — hydrated states', () => {
  test('renders checking state', async () => {
    mockUpdate.getState.mockResolvedValue({ state: 'checking' })

    await act(async () => {
      createRoot(container!).render(<UpdateBanner />)
    })

    expect(container!.innerHTML).toContain('Checking for updates')
    expect(container!.innerHTML).toContain('data-state="checking"')
  })

  test('renders available state with version and download button', async () => {
    mockUpdate.getState.mockResolvedValue({ state: 'available', info: { version: '2.3.4' } })

    await act(async () => {
      createRoot(container!).render(<UpdateBanner />)
    })

    expect(container!.innerHTML).toContain('2.3.4')
    expect(container!.innerHTML).toContain('Download')
    expect(container!.innerHTML).toContain('data-state="available"')
  })

  test('renders downloading state with percent', async () => {
    mockUpdate.getState.mockResolvedValue({
      state: 'downloading',
      progress: { percent: 42, bytesPerSecond: 0 },
    })

    await act(async () => {
      createRoot(container!).render(<UpdateBanner />)
    })

    expect(container!.innerHTML).toContain('42%')
    expect(container!.innerHTML).toContain('data-state="downloading"')
  })

  test('renders downloading state with MB/s when speed > 0', async () => {
    mockUpdate.getState.mockResolvedValue({
      state: 'downloading',
      progress: { percent: 60, bytesPerSecond: 2 * 1024 * 1024 },
    })

    await act(async () => {
      createRoot(container!).render(<UpdateBanner />)
    })

    expect(container!.innerHTML).toContain('MB/s')
  })

  test('renders downloaded state with restart button', async () => {
    mockUpdate.getState.mockResolvedValue({ state: 'downloaded', info: { version: '2.3.4' } })

    await act(async () => {
      createRoot(container!).render(<UpdateBanner />)
    })

    expect(container!.innerHTML).toContain('Restart')
    expect(container!.innerHTML).toContain('v2.3.4')
    expect(container!.innerHTML).toContain('data-state="downloaded"')
  })

  test('renders error state with error message and dismiss button', async () => {
    mockUpdate.getState.mockResolvedValue({ state: 'error', error: 'Network timeout' })

    await act(async () => {
      createRoot(container!).render(<UpdateBanner />)
    })

    expect(container!.innerHTML).toContain('Network timeout')
    expect(container!.innerHTML).toContain('Dismiss')
    expect(container!.innerHTML).toContain('data-state="error"')
  })

  test('renders nothing in not-available state', async () => {
    mockUpdate.getState.mockResolvedValue({ state: 'not-available' })

    await act(async () => {
      createRoot(container!).render(<UpdateBanner />)
    })

    expect(container!.innerHTML).toBe('')
  })
})

describe('UpdateBanner — button interactions', () => {
  test('download button calls sb.update.download()', async () => {
    mockUpdate.getState.mockResolvedValue({ state: 'available', info: { version: '1.0.0' } })

    await act(async () => {
      createRoot(container!).render(<UpdateBanner />)
    })

    const btn = container!.querySelector('button') as HTMLButtonElement
    expect(btn).not.toBeNull()

    await act(async () => { btn.click() })
    expect(mockUpdate.download).toHaveBeenCalledTimes(1)
  })

  test('install button calls sb.update.install()', async () => {
    mockUpdate.getState.mockResolvedValue({ state: 'downloaded', info: { version: '1.0.0' } })

    await act(async () => {
      createRoot(container!).render(<UpdateBanner />)
    })

    const btn = container!.querySelector('button') as HTMLButtonElement
    expect(btn).not.toBeNull()

    await act(async () => { btn.click() })
    expect(mockUpdate.install).toHaveBeenCalledTimes(1)
  })

  test('dismiss button hides the banner', async () => {
    mockUpdate.getState.mockResolvedValue({ state: 'error', error: 'Something failed' })

    await act(async () => {
      createRoot(container!).render(<UpdateBanner />)
    })

    expect(container!.innerHTML).not.toBe('')

    const btn = container!.querySelector('button') as HTMLButtonElement
    await act(async () => { btn.click() })

    expect(container!.innerHTML).toBe('')
  })
})

describe('UpdateBanner — event listeners', () => {
  test('registers all six event listeners on mount', async () => {
    await act(async () => {
      createRoot(container!).render(<UpdateBanner />)
    })

    expect(mockUpdate.onChecking).toHaveBeenCalledTimes(1)
    expect(mockUpdate.onAvailable).toHaveBeenCalledTimes(1)
    expect(mockUpdate.onNotAvailable).toHaveBeenCalledTimes(1)
    expect(mockUpdate.onProgress).toHaveBeenCalledTimes(1)
    expect(mockUpdate.onDownloaded).toHaveBeenCalledTimes(1)
    expect(mockUpdate.onError).toHaveBeenCalledTimes(1)
  })

  test('onAvailable callback updates state to available', async () => {
    let capturedOnAvailable: ((info: { version: string }) => void) | null = null
    mockUpdate.onAvailable.mockImplementation((cb: (info: { version: string }) => void) => {
      capturedOnAvailable = cb
      return () => {}
    })

    await act(async () => {
      createRoot(container!).render(<UpdateBanner />)
    })

    await act(async () => {
      capturedOnAvailable!({ version: '9.9.9' })
    })

    expect(container!.innerHTML).toContain('9.9.9')
    expect(container!.innerHTML).toContain('Download')
  })

  test('onDownloaded callback updates state to downloaded', async () => {
    let capturedOnDownloaded: ((info: { version: string }) => void) | null = null
    mockUpdate.onDownloaded.mockImplementation((cb: (info: { version: string }) => void) => {
      capturedOnDownloaded = cb
      return () => {}
    })

    await act(async () => {
      createRoot(container!).render(<UpdateBanner />)
    })

    await act(async () => {
      capturedOnDownloaded!({ version: '9.9.9' })
    })

    expect(container!.innerHTML).toContain('Restart')
  })
})
