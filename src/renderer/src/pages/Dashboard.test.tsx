import { describe, test, expect, vi, beforeEach } from 'vitest'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

const mocks = vi.hoisted(() => {
  const mockSwarmStatus = vi.fn().mockResolvedValue({ workerCount: 0, planning: false })
  const mockBeadStats = vi.fn().mockResolvedValue({ ok: true, stats: { total: 5, done: 2, ready: 1, claimed: 1, pct: 40 } })
  const mockOnAgents = vi.fn().mockReturnValue(() => {})
  const mockResetCircuit = vi.fn().mockResolvedValue({ ok: true })
  ;(globalThis as any).window = {
    slashbot: {
      swarm: {
        status: mockSwarmStatus,
        start: vi.fn().mockResolvedValue({ ok: true }),
        stop: vi.fn().mockResolvedValue({ ok: true }),
        onAgents: mockOnAgents,
      },
      beads: { stats: mockBeadStats },
      resetCircuit: mockResetCircuit,
    },
  }

  return { mockSwarmStatus, mockBeadStats, mockOnAgents, mockResetCircuit }
})

import Dashboard from './Dashboard'

beforeEach(() => {
  vi.clearAllMocks()
  mocks.mockSwarmStatus.mockResolvedValue({ workerCount: 0, planning: false })
  mocks.mockBeadStats.mockResolvedValue({ ok: true, stats: { total: 5, done: 2, ready: 1, claimed: 1, pct: 40 } })
})

describe('Dashboard', () => {
  test('renders without status prop', () => {
    const html = renderToStaticMarkup(
      <Dashboard projectPath="/test" circuit={null} onNavigate={() => {}} />
    )
    expect(html).toContain('Dashboard')
  })

  test('does not render Rate Limit card', () => {
    const html = renderToStaticMarkup(
      <Dashboard projectPath="/test" circuit={null} onNavigate={() => {}} />
    )
    expect(html).not.toContain('Rate Limit')
    expect(html).not.toContain('API Calls')
    expect(html).not.toContain('Loop Count')
  })

  test('renders circuit breaker card with circuit prop', () => {
    const html = renderToStaticMarkup(
      <Dashboard
        projectPath="/test"
        circuit={{ state: 'CLOSED', last_change: '', consecutive_no_progress: 0, consecutive_same_error: 0, consecutive_permission_denials: 0, last_progress_loop: 0, total_opens: 0, reason: '', current_loop: 0 }}
        onNavigate={() => {}}
      />
    )
    expect(html).toContain('Circuit Breaker')
    expect(html).toContain('CLOSED')
  })

  test('renders Swarm Engine card', () => {
    const html = renderToStaticMarkup(
      <Dashboard projectPath="/test" circuit={null} onNavigate={() => {}} />
    )
    expect(html).toContain('Swarm Engine')
  })

  test('renders progress ring', () => {
    const html = renderToStaticMarkup(
      <Dashboard projectPath="/test" circuit={null} onNavigate={() => {}} />
    )
    expect(html).toContain('progress-ring')
    expect(html).toContain('Complete')
  })

  test('does not render check for updates button', () => {
    const html = renderToStaticMarkup(
      <Dashboard projectPath="/test" circuit={null} onNavigate={() => {}} />
    )
    expect(html).not.toContain('Check for updates')
  })
})
