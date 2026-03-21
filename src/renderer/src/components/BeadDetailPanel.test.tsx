import { describe, test, expect, vi, beforeEach } from 'vitest'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

// Must set up window before any module-level access in the component
const mockActivity = vi.fn().mockResolvedValue([])
const mockAgentLogs = vi.fn().mockResolvedValue([])
const mockAgentLogContent = vi.fn().mockResolvedValue('')

vi.stubGlobal('window', {
  slashbot: {
    swarm: {
      activity: mockActivity,
      agentLogs: mockAgentLogs,
      agentLogContent: mockAgentLogContent,
    },
  },
})

import BeadDetailPanel from './BeadDetailPanel'

beforeEach(() => {
  mockActivity.mockReset().mockResolvedValue([])
  mockAgentLogs.mockReset().mockResolvedValue([])
  mockAgentLogContent.mockReset().mockResolvedValue('')
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
})
