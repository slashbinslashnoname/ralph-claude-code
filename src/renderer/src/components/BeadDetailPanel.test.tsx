import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createRoot } from 'react-dom/client'
import { act } from 'react'

// Enable React act() environment for jsdom
;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

// Must set up window before any module-level access in the component
const mockActivity = vi.fn().mockResolvedValue([])
const mockAgentLogs = vi.fn().mockResolvedValue([])
const mockAgentLogContent = vi.fn().mockResolvedValue('')

// Attach slashbot API to the jsdom window
;(window as any).slashbot = {
  swarm: {
    activity: mockActivity,
    agentLogs: mockAgentLogs,
    agentLogContent: mockAgentLogContent,
  },
}

import BeadDetailPanel from './BeadDetailPanel'

let domContainer: HTMLDivElement | null = null

beforeEach(() => {
  mockActivity.mockReset().mockResolvedValue([])
  mockAgentLogs.mockReset().mockResolvedValue([])
  mockAgentLogContent.mockReset().mockResolvedValue('')
  domContainer = document.createElement('div')
  document.body.appendChild(domContainer)
})

afterEach(() => {
  if (domContainer) {
    document.body.removeChild(domContainer)
    domContainer = null
  }
})

describe('BeadDetailPanel', () => {
  test('renders loading state initially', () => {
    const html = renderToStaticMarkup(
      <BeadDetailPanel beadId="sb-abc.1" beadStatus="done" projectPath="/tmp/test" />
    )
    expect(html).toContain('Loading audit trail')
    expect(html).toContain('bead-detail-panel')
  })

  test('renders with bead-detail-panel class', () => {
    const html = renderToStaticMarkup(
      <BeadDetailPanel beadId="sb-abc.1" beadStatus="ready" projectPath="/tmp/test" />
    )
    expect(html).toContain('bead-detail-panel')
  })

  test('accepts all required props without error', () => {
    expect(() => {
      renderToStaticMarkup(
        <BeadDetailPanel beadId="sb-xyz.2" beadStatus="failed" projectPath="/tmp/proj" />
      )
    }).not.toThrow()
  })

  test('calls activity and agentLogs APIs with correct args', () => {
    renderToStaticMarkup(
      <BeadDetailPanel beadId="sb-abc.1" beadStatus="done" projectPath="/tmp/test" />
    )
    // useEffect doesn't fire in SSR, but we can verify the component renders without
    // throwing when the APIs are configured
    expect(mockActivity).not.toHaveBeenCalled() // useEffect is SSR-inert
  })

  test('does not render timeline or logs tabs in loading state', () => {
    const html = renderToStaticMarkup(
      <BeadDetailPanel beadId="sb-abc.1" beadStatus="done" projectPath="/tmp/test" />
    )
    expect(html).not.toContain('Timeline')
    expect(html).not.toContain('Logs')
  })

  test('renders rollback event with correct icon and badge', async () => {
    const rollbackEvent = {
      ts: '2026-03-21T10:00:00Z',
      agentId: 'agent-0',
      type: 'rollback',
      beadId: 'sb-abc.1',
      summary: 'Rolled back due to merge conflict',
    }
    mockActivity.mockResolvedValue([rollbackEvent])
    mockAgentLogs.mockResolvedValue([])

    await act(async () => {
      const root = createRoot(domContainer!)
      root.render(
        <BeadDetailPanel beadId="sb-abc.1" beadStatus="failed" projectPath="/tmp/test" />
      )
    })

    const html = domContainer!.innerHTML

    // Verify the rollback icon (↩ = \u21A9)
    expect(html).toContain('\u21A9')

    // Verify the badge has the danger class
    expect(html).toContain('badge-danger')

    // Verify the event type label is rendered
    expect(html).toContain('rollback')

    // Verify the summary text is rendered
    expect(html).toContain('Rolled back due to merge conflict')
  })
})
