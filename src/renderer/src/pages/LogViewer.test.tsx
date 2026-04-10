import { describe, test, expect, vi, beforeEach } from 'vitest'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

const { mockReadLogs } = vi.hoisted(() => {
  const mockReadLogs = vi.fn().mockResolvedValue(['[INFO] Boot complete'])
  const noop = vi.fn().mockReturnValue(() => {})

  ;(globalThis as any).window = {
    slashbot: {
      readLogs: mockReadLogs,
      onLogLines: noop,
    },
  }
  return { mockReadLogs }
})

import LogViewer from './LogViewer'
import { ToastProvider } from '../components/Toast'

// Mock sessionStorage for persistence tests
const sessionStore: Record<string, string> = {}
const mockSessionStorage = {
  getItem: vi.fn((key: string) => sessionStore[key] ?? null),
  setItem: vi.fn((key: string, value: string) => { sessionStore[key] = value }),
  removeItem: vi.fn((key: string) => { delete sessionStore[key] }),
  clear: vi.fn(() => { for (const k of Object.keys(sessionStore)) delete sessionStore[k] }),
  get length() { return Object.keys(sessionStore).length },
  key: vi.fn((i: number) => Object.keys(sessionStore)[i] ?? null),
}
Object.defineProperty(globalThis, 'sessionStorage', { value: mockSessionStorage, writable: true })

beforeEach(() => {
  mockReadLogs.mockReset().mockResolvedValue(['[INFO] Boot complete'])
  mockSessionStorage.getItem.mockClear()
  mockSessionStorage.setItem.mockClear()
  for (const k of Object.keys(sessionStore)) delete sessionStore[k]
})

function renderLogViewer(props: { projectPath: string } = { projectPath: '/tmp/test' }) {
  return renderToStaticMarkup(
    <ToastProvider>
      <LogViewer {...props} />
    </ToastProvider>
  )
}

describe('LogViewer', () => {
  test('renders page header', () => {
    const html = renderLogViewer()
    expect(html).toContain('Logs')
  })

  test('renders auto-scroll toggle', () => {
    const html = renderLogViewer()
    expect(html).toContain('Auto-scroll')
  })

  test('renders clear button', () => {
    const html = renderLogViewer()
    expect(html).toContain('Clear')
  })

  test('readLogs failure does not crash the component', () => {
    mockReadLogs.mockRejectedValue(new Error('File not found'))
    const html = renderLogViewer()
    expect(html).toContain('Logs')
  })

  test('renders search input', () => {
    const html = renderLogViewer()
    expect(html).toContain('Search logs')
    expect(html).toContain('log-search-input')
  })

  test('renders level filter checkboxes', () => {
    const html = renderLogViewer()
    expect(html).toContain('ALL')
    expect(html).toContain('ERROR')
    expect(html).toContain('WARN')
    expect(html).toContain('INFO')
  })

  test('renders level filter chips with correct classes', () => {
    const html = renderLogViewer()
    expect(html).toContain('log-level-chip')
    expect(html).toContain('level-all')
    expect(html).toContain('level-error')
    expect(html).toContain('level-warn')
    expect(html).toContain('level-info')
  })

  test('ALL level chip is active by default', () => {
    const html = renderLogViewer()
    // The ALL chip should have 'active' class
    expect(html).toMatch(/level-all[^"]*active|active[^"]*level-all/)
  })

  test('renders log-toolbar container', () => {
    const html = renderLogViewer()
    expect(html).toContain('log-toolbar')
  })

  test('reads search from sessionStorage on mount', () => {
    sessionStore['logviewer-search'] = 'previous query'
    const html = renderLogViewer()
    expect(html).toContain('previous query')
  })

  test('reads levels from sessionStorage on mount', () => {
    sessionStore['logviewer-levels'] = JSON.stringify(['ERROR'])
    const html = renderLogViewer()
    // ERROR chip should be active, ALL should not
    expect(html).toMatch(/active[^"]*level-error|level-error[^"]*active/)
    expect(html).not.toMatch(/active[^"]*level-all|level-all[^"]*active/)
  })

  test('handles invalid sessionStorage levels gracefully', () => {
    sessionStore['logviewer-levels'] = 'not-json'
    // Should not throw, falls back to ALL
    const html = renderLogViewer()
    expect(html).toContain('Logs')
    expect(html).toMatch(/level-all[^"]*active|active[^"]*level-all/)
  })

  test('handles empty array in sessionStorage levels', () => {
    sessionStore['logviewer-levels'] = '[]'
    const html = renderLogViewer()
    // Should fall back to ALL
    expect(html).toMatch(/level-all[^"]*active|active[^"]*level-all/)
  })
})
