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

beforeEach(() => {
  mockReadLogs.mockReset().mockResolvedValue(['[INFO] Boot complete'])
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
})
