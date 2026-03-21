import { describe, test, expect } from 'vitest'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import DependencyDAG, { DAGBead } from './DependencyDAG'

function render(beads: DAGBead[]): string {
  return renderToStaticMarkup(<DependencyDAG beads={beads} />)
}

function countOccurrences(html: string, pattern: string): number {
  return html.split(pattern).length - 1
}

describe('DependencyDAG', () => {
  test('renders an SVG element for empty input', () => {
    const html = render([])
    expect(html.startsWith('<svg')).toBe(true)
    expect(html).toContain('data-testid="dependency-dag"')
  })

  test('renders correct number of nodes', () => {
    const beads: DAGBead[] = [
      { id: 'a', title: 'Task A', status: 'ready', deps: [] },
      { id: 'b', title: 'Task B', status: 'done', deps: ['a'] },
    ]
    const html = render(beads)
    expect(countOccurrences(html, 'data-testid="dag-node"')).toBe(2)
  })

  test('renders edge between dependent beads', () => {
    const beads: DAGBead[] = [
      { id: 'a', title: 'Task A', status: 'ready', deps: [] },
      { id: 'b', title: 'Task B', status: 'pending', deps: ['a'] },
    ]
    const html = render(beads)
    expect(countOccurrences(html, 'data-testid="dag-edge"')).toBe(1)
  })

  test('skips edges where dependency bead is missing', () => {
    const beads: DAGBead[] = [
      { id: 'a', title: 'Task A', status: 'ready', deps: ['nonexistent'] },
    ]
    const html = render(beads)
    expect(countOccurrences(html, 'data-testid="dag-node"')).toBe(1)
    expect(countOccurrences(html, 'data-testid="dag-edge"')).toBe(0)
  })

  test('handles cyclic dependencies without error', () => {
    const beads: DAGBead[] = [
      { id: 'a', title: 'Task A', status: 'ready', deps: ['b'] },
      { id: 'b', title: 'Task B', status: 'pending', deps: ['a'] },
    ]
    // Should not throw
    const html = render(beads)
    expect(html.startsWith('<svg')).toBe(true)
    expect(countOccurrences(html, 'data-testid="dag-node"')).toBe(2)
    // At least one back-edge should be removed to break the cycle
    expect(countOccurrences(html, 'data-testid="dag-edge"')).toBeLessThanOrEqual(1)
  })

  test('epicId creates edge from epic to child', () => {
    const beads: DAGBead[] = [
      { id: 'epic-1', title: 'Epic', status: 'ready', deps: [] },
      { id: 'task-1', title: 'Task', status: 'pending', deps: [], epicId: 'epic-1' },
    ]
    const html = render(beads)
    expect(countOccurrences(html, 'data-testid="dag-edge"')).toBe(1)
  })

  test('epicId edge skipped when epic bead is missing', () => {
    const beads: DAGBead[] = [
      { id: 'task-1', title: 'Task', status: 'pending', deps: [], epicId: 'missing-epic' },
    ]
    const html = render(beads)
    expect(countOccurrences(html, 'data-testid="dag-edge"')).toBe(0)
  })

  test('status colors are applied correctly', () => {
    const statuses: Array<DAGBead['status']> = ['pending', 'ready', 'claimed', 'done', 'failed']
    const expectedColors: Record<string, string> = {
      pending: '#6b7280',
      ready: '#3b82f6',
      claimed: '#f59e0b',
      done: '#10b981',
      failed: '#ef4444',
    }

    for (const status of statuses) {
      const beads: DAGBead[] = [{ id: `s-${status}`, title: status, status, deps: [] }]
      const html = render(beads)
      expect(html).toContain(expectedColors[status])
    }
  })

  test('displays bead title and id', () => {
    const beads: DAGBead[] = [
      { id: 'abc-123', title: 'My Task', status: 'ready', deps: [] },
    ]
    const html = render(beads)
    expect(html).toContain('My Task')
    expect(html).toContain('abc-123')
  })

  test('truncates long titles', () => {
    const beads: DAGBead[] = [
      { id: 'x', title: 'This is a very long title that exceeds the limit', status: 'ready', deps: [] },
    ]
    const html = render(beads)
    expect(html).toContain('\u2026') // ellipsis
    expect(html).not.toContain('exceeds the limit')
  })
})
