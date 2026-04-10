import { describe, test, expect, vi, beforeEach } from 'vitest'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { CircuitBreakerSnapshot } from '../types/ipc'

const mocks = vi.hoisted(() => {
  const mockSwarmStatus = vi.fn().mockResolvedValue({ workerCount: 0, planning: false })
  const mockBeadStats = vi.fn().mockResolvedValue({ ok: true, stats: { total: 5, done: 2, ready: 1, claimed: 1, pct: 40 } })
  const mockOnAgents = vi.fn().mockReturnValue(() => {})
  const mockResetCircuit = vi.fn().mockResolvedValue({ ok: true })
  const mockClearStaleCircuits = vi.fn().mockResolvedValue({ ok: true, removed: [] })
  const mockOnCircuitRemove = vi.fn().mockReturnValue(() => {})
  ;(globalThis as any).window = {
    slashbot: {
      swarm: {
        status: mockSwarmStatus,
        start: vi.fn().mockResolvedValue({ ok: true }),
        stop: vi.fn().mockResolvedValue({ ok: true }),
        onAgents: mockOnAgents,
        onSwarmPhase: vi.fn().mockReturnValue(() => {}),
      },
      beads: { stats: mockBeadStats },
      resetCircuit: mockResetCircuit,
      clearStaleCircuits: mockClearStaleCircuits,
      onCircuitRemove: mockOnCircuitRemove,
    },
  }

  return { mockSwarmStatus, mockBeadStats, mockOnAgents, mockResetCircuit, mockClearStaleCircuits }
})

import Dashboard from './Dashboard'

function makeSnapshot(overrides: Partial<CircuitBreakerSnapshot> = {}): CircuitBreakerSnapshot {
  return {
    state: 'CLOSED',
    last_change: '',
    consecutive_no_progress: 0,
    consecutive_same_error: 0,
    error_window_count: 0,
    consecutive_permission_denials: 0,
    last_progress_loop: 0,
    total_opens: 0,
    reason: '',
    current_loop: 0,
    reopen_epoch: 0,
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.mockSwarmStatus.mockResolvedValue({ workerCount: 0, planning: false })
  mocks.mockBeadStats.mockResolvedValue({ ok: true, stats: { total: 5, done: 2, ready: 1, claimed: 1, pct: 40 } })
})

describe('Dashboard', () => {
  test('renders without circuits', () => {
    const html = renderToStaticMarkup(
      <Dashboard projectPath="/test" circuits={{}} onNavigate={() => {}} />
    )
    expect(html).toContain('Dashboard')
    expect(html).toContain('No circuit breaker data yet')
  })

  test('does not render Rate Limit card', () => {
    const html = renderToStaticMarkup(
      <Dashboard projectPath="/test" circuits={{}} onNavigate={() => {}} />
    )
    expect(html).not.toContain('Rate Limit')
    expect(html).not.toContain('API Calls')
    expect(html).not.toContain('Loop Count')
  })

  test('renders per-worker circuit rows', () => {
    const circuits = {
      'worker-0': makeSnapshot({ state: 'CLOSED', error_window_count: 2 }),
      'worker-1': makeSnapshot({ state: 'HALF_OPEN', error_window_count: 4 }),
    }
    const html = renderToStaticMarkup(
      <Dashboard projectPath="/test" circuits={circuits} onNavigate={() => {}} />
    )
    expect(html).toContain('worker-0')
    expect(html).toContain('worker-1')
    expect(html).toContain('CLOSED')
    expect(html).toContain('HALF_OPEN')
    expect(html).toContain('Errors: 2')
    expect(html).toContain('Errors: 4')
  })

  test('renders red warning pill when any agent is OPEN', () => {
    const circuits = {
      'worker-0': makeSnapshot({ state: 'CLOSED' }),
      'worker-1': makeSnapshot({ state: 'OPEN', error_window_count: 5 }),
    }
    const html = renderToStaticMarkup(
      <Dashboard projectPath="/test" circuits={circuits} onNavigate={() => {}} />
    )
    expect(html).toContain('pill-red')
    expect(html).toContain('data-testid="circuit-warning-pill"')
    expect(html).toContain('OPEN')
  })

  test('renders amber warning pill when any agent is HALF_OPEN (none OPEN)', () => {
    const circuits = {
      'worker-0': makeSnapshot({ state: 'CLOSED' }),
      'worker-1': makeSnapshot({ state: 'HALF_OPEN' }),
    }
    const html = renderToStaticMarkup(
      <Dashboard projectPath="/test" circuits={circuits} onNavigate={() => {}} />
    )
    expect(html).toContain('pill-amber')
    expect(html).toContain('data-testid="circuit-warning-pill"')
  })

  test('no warning pill when all agents CLOSED', () => {
    const circuits = {
      'worker-0': makeSnapshot({ state: 'CLOSED' }),
      'worker-1': makeSnapshot({ state: 'CLOSED' }),
    }
    const html = renderToStaticMarkup(
      <Dashboard projectPath="/test" circuits={circuits} onNavigate={() => {}} />
    )
    expect(html).not.toContain('pill-red')
    expect(html).not.toContain('pill-amber')
    expect(html).not.toContain('circuit-warning-pill')
  })

  test('shows reset button only for OPEN agents', () => {
    const circuits = {
      'worker-0': makeSnapshot({ state: 'CLOSED' }),
      'worker-1': makeSnapshot({ state: 'OPEN' }),
    }
    const html = renderToStaticMarkup(
      <Dashboard projectPath="/test" circuits={circuits} onNavigate={() => {}} />
    )
    // Only one Reset button (for the OPEN agent)
    const resetCount = (html.match(/Reset<\/button>/g) || []).length
    expect(resetCount).toBe(1)
  })

  test('shows reason for OPEN circuit breaker', () => {
    const circuits = {
      'worker-0': makeSnapshot({ state: 'OPEN', reason: 'too many errors in window' }),
    }
    const html = renderToStaticMarkup(
      <Dashboard projectPath="/test" circuits={circuits} onNavigate={() => {}} />
    )
    expect(html).toContain('data-testid="circuit-reason"')
    expect(html).toContain('too many errors in window')
  })

  test('does not show reason block when reason is empty', () => {
    const circuits = {
      'worker-0': makeSnapshot({ state: 'OPEN', reason: '' }),
    }
    const html = renderToStaticMarkup(
      <Dashboard projectPath="/test" circuits={circuits} onNavigate={() => {}} />
    )
    expect(html).not.toContain('data-testid="circuit-reason"')
  })

  test('shows rate limit suggestion when rate_limit_until is set', () => {
    const circuits = {
      'worker-0': makeSnapshot({ state: 'OPEN', rate_limit_until: '2026-04-10T12:00:00Z' }),
    }
    const html = renderToStaticMarkup(
      <Dashboard projectPath="/test" circuits={circuits} onNavigate={() => {}} />
    )
    expect(html).toContain('data-testid="circuit-suggestion"')
    expect(html).toContain('API rate limit hit')
  })

  test('shows no-progress suggestion when consecutive_no_progress > 0', () => {
    const circuits = {
      'worker-0': makeSnapshot({ state: 'OPEN', consecutive_no_progress: 3 }),
    }
    const html = renderToStaticMarkup(
      <Dashboard projectPath="/test" circuits={circuits} onNavigate={() => {}} />
    )
    expect(html).toContain('no progress')
    expect(html).toContain('bead needs splitting')
  })

  test('shows same-error suggestion when consecutive_same_error > 0', () => {
    const circuits = {
      'worker-0': makeSnapshot({ state: 'OPEN', consecutive_same_error: 2 }),
    }
    const html = renderToStaticMarkup(
      <Dashboard projectPath="/test" circuits={circuits} onNavigate={() => {}} />
    )
    expect(html).toContain('same error repeatedly')
  })

  test('shows permission denial suggestion when consecutive_permission_denials > 0', () => {
    const circuits = {
      'worker-0': makeSnapshot({ state: 'OPEN', consecutive_permission_denials: 5 }),
    }
    const html = renderToStaticMarkup(
      <Dashboard projectPath="/test" circuits={circuits} onNavigate={() => {}} />
    )
    expect(html).toContain('denied permissions')
  })

  test('shows generic error-window suggestion as fallback', () => {
    const circuits = {
      'worker-0': makeSnapshot({ state: 'OPEN', error_window_count: 8 }),
    }
    const html = renderToStaticMarkup(
      <Dashboard projectPath="/test" circuits={circuits} onNavigate={() => {}} />
    )
    expect(html).toContain('Too many errors in a short window')
  })

  test('shows View Logs button for OPEN circuits', () => {
    const circuits = {
      'worker-0': makeSnapshot({ state: 'OPEN' }),
    }
    const html = renderToStaticMarkup(
      <Dashboard projectPath="/test" circuits={circuits} onNavigate={() => {}} />
    )
    expect(html).toContain('View Logs')
  })

  test('shows opened_at relative time for OPEN circuit', () => {
    const fiveMinAgo = new Date(Date.now() - 5 * 60_000).toISOString()
    const circuits = {
      'worker-0': makeSnapshot({ state: 'OPEN', opened_at: fiveMinAgo }),
    }
    const html = renderToStaticMarkup(
      <Dashboard projectPath="/test" circuits={circuits} onNavigate={() => {}} />
    )
    expect(html).toContain('data-testid="circuit-context"')
    expect(html).toContain('Opened')
    expect(html).toContain('5m ago')
  })

  test('shows total_opens count when tripped multiple times', () => {
    const circuits = {
      'worker-0': makeSnapshot({ state: 'OPEN', total_opens: 3 }),
    }
    const html = renderToStaticMarkup(
      <Dashboard projectPath="/test" circuits={circuits} onNavigate={() => {}} />
    )
    expect(html).toContain('data-testid="circuit-total-opens"')
    expect(html).toContain('Tripped 3 times')
  })

  test('does not show total_opens when only tripped once', () => {
    const circuits = {
      'worker-0': makeSnapshot({ state: 'OPEN', total_opens: 1 }),
    }
    const html = renderToStaticMarkup(
      <Dashboard projectPath="/test" circuits={circuits} onNavigate={() => {}} />
    )
    expect(html).not.toContain('data-testid="circuit-total-opens"')
  })

  test('shows cooldown epoch in context for OPEN circuit', () => {
    const circuits = {
      'worker-0': makeSnapshot({ state: 'OPEN', reopen_epoch: 2 }),
    }
    const html = renderToStaticMarkup(
      <Dashboard projectPath="/test" circuits={circuits} onNavigate={() => {}} />
    )
    expect(html).toContain('Cooldown epoch 2')
  })

  test('does not show circuit context for CLOSED circuits', () => {
    const circuits = {
      'worker-0': makeSnapshot({ state: 'CLOSED' }),
    }
    const html = renderToStaticMarkup(
      <Dashboard projectPath="/test" circuits={circuits} onNavigate={() => {}} />
    )
    expect(html).not.toContain('circuit-context')
  })

  test('shows opened just now for very recent open', () => {
    const justNow = new Date(Date.now() - 5_000).toISOString()
    const circuits = {
      'worker-0': makeSnapshot({ state: 'OPEN', opened_at: justNow }),
    }
    const html = renderToStaticMarkup(
      <Dashboard projectPath="/test" circuits={circuits} onNavigate={() => {}} />
    )
    expect(html).toContain('Opened just now')
  })

  test('does not show recovery section for CLOSED circuits', () => {
    const circuits = {
      'worker-0': makeSnapshot({ state: 'CLOSED' }),
    }
    const html = renderToStaticMarkup(
      <Dashboard projectPath="/test" circuits={circuits} onNavigate={() => {}} />
    )
    expect(html).not.toContain('circuit-recovery')
    expect(html).not.toContain('circuit-suggestion')
  })

  test('collapses circuit list when more than 3 agents', () => {
    const circuits: Record<string, CircuitBreakerSnapshot> = {}
    for (let i = 0; i < 5; i++) {
      circuits[`worker-${i}`] = makeSnapshot()
    }
    const html = renderToStaticMarkup(
      <Dashboard projectPath="/test" circuits={circuits} onNavigate={() => {}} />
    )
    // Should show first 3 and a "Show 2 more" button
    expect(html).toContain('worker-0')
    expect(html).toContain('worker-1')
    expect(html).toContain('worker-2')
    expect(html).not.toContain('worker-3')
    expect(html).not.toContain('worker-4')
    expect(html).toContain('Show 2 more')
  })

  test('shows reopen epoch and rate-limit-until when present', () => {
    const circuits = {
      'worker-0': makeSnapshot({ reopen_epoch: 3, rate_limit_until: '2026-03-25T12:00:00Z' }),
    }
    const html = renderToStaticMarkup(
      <Dashboard projectPath="/test" circuits={circuits} onNavigate={() => {}} />
    )
    expect(html).toContain('Reopen: 3')
    expect(html).toContain('Rate-limit: 2026-03-25T12:00:00Z')
  })

  test('renders Swarm Engine card', () => {
    const html = renderToStaticMarkup(
      <Dashboard projectPath="/test" circuits={{}} onNavigate={() => {}} />
    )
    expect(html).toContain('Swarm Engine')
  })

  test('renders progress ring', () => {
    const html = renderToStaticMarkup(
      <Dashboard projectPath="/test" circuits={{}} onNavigate={() => {}} />
    )
    expect(html).toContain('progress-ring')
    expect(html).toContain('Complete')
  })

  test('does not render check for updates button', () => {
    const html = renderToStaticMarkup(
      <Dashboard projectPath="/test" circuits={{}} onNavigate={() => {}} />
    )
    expect(html).not.toContain('Check for updates')
  })

  test('shows clear stale circuits button when circuits exist for unregistered agents', () => {
    // No agents registered (default mock returns workerCount: 0, agents: undefined)
    const circuits = {
      'worker-0': makeSnapshot({ state: 'CLOSED' }),
      'worker-1': makeSnapshot({ state: 'CLOSED' }),
    }
    const html = renderToStaticMarkup(
      <Dashboard projectPath="/test" circuits={circuits} onNavigate={() => {}} />
    )
    expect(html).toContain('data-testid="clear-stale-circuits"')
    expect(html).toContain('Clear 2 stale')
  })

  test('does not show clear stale circuits button when no circuits exist', () => {
    const html = renderToStaticMarkup(
      <Dashboard projectPath="/test" circuits={{}} onNavigate={() => {}} />
    )
    expect(html).not.toContain('clear-stale-circuits')
  })

  test('clear stale circuits button label reflects count', () => {
    const circuits = {
      'worker-0': makeSnapshot({ state: 'CLOSED' }),
    }
    const html = renderToStaticMarkup(
      <Dashboard projectPath="/test" circuits={circuits} onNavigate={() => {}} />
    )
    expect(html).toContain('Clear 1 stale')
  })
})
