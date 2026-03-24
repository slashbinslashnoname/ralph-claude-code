import { describe, test, expect, vi, beforeEach } from 'vitest'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

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

;(globalThis as unknown as { window: { slashbot: { update: typeof mockUpdate } } }).window = {
  slashbot: { update: mockUpdate },
} as unknown as typeof window

import UpdateBanner from './UpdateBanner'

beforeEach(() => {
  vi.clearAllMocks()
  mockUpdate.getState.mockResolvedValue(null)
})

describe('UpdateBanner', () => {
  test('renders nothing in idle state (default)', () => {
    const html = renderToStaticMarkup(<UpdateBanner />)
    expect(html).toBe('')
  })

  test('component exports a function', () => {
    expect(typeof UpdateBanner).toBe('function')
  })

  test('renders as a React element', () => {
    const element = React.createElement(UpdateBanner)
    expect(element).toBeDefined()
    expect(element.type).toBe(UpdateBanner)
  })
})
