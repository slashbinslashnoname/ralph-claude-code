import { describe, test, expect } from 'vitest'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import DependencyDAG, { DAGBead, findCriticalPath } from './DependencyDAG'

function render(beads: DAGBead[]): string {
  return renderToStaticMarkup(<DependencyDAG beads={beads} />)
}

function countOccurrences(html: string, pattern: string): number {
  return html.split(pattern).length - 1
}

describe('DependencyDAG', () => {
  test('renders an SVG element for empty input', () => {
    const html = render([])
    expect(html).toContain('<svg')
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
    expect(html).toContain('<svg')
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

  test('renders reset view button', () => {
    const html = render([])
    expect(html).toContain('data-testid="dag-reset-view"')
    expect(html).toContain('Reset View')
  })

  test('renders with grab cursor for pan interaction', () => {
    const html = render([])
    expect(html).toContain('cursor:grab')
  })

  test('critical edges have dag-critical class', () => {
    const beads: DAGBead[] = [
      { id: 'a', title: 'A', status: 'ready', deps: [] },
      { id: 'b', title: 'B', status: 'pending', deps: ['a'] },
      { id: 'c', title: 'C', status: 'pending', deps: ['b'] },
    ]
    const html = render(beads)
    expect(html).toContain('dag-critical')
  })

  test('critical edges have distinct stroke color', () => {
    const beads: DAGBead[] = [
      { id: 'a', title: 'A', status: 'ready', deps: [] },
      { id: 'b', title: 'B', status: 'pending', deps: ['a'] },
      { id: 'c', title: 'C', status: 'pending', deps: ['b'] },
    ]
    const html = render(beads)
    // Critical path edges use orange
    expect(html).toContain('stroke="#f97316"')
    expect(html).toContain('stroke-width="3"')
  })

  test('no critical class on single node', () => {
    const beads: DAGBead[] = [
      { id: 'a', title: 'A', status: 'ready', deps: [] },
    ]
    const html = render(beads)
    expect(html).not.toContain('dag-critical')
  })

  test('renders critical arrowhead marker', () => {
    const html = render([
      { id: 'a', title: 'A', status: 'ready', deps: [] },
      { id: 'b', title: 'B', status: 'pending', deps: ['a'] },
    ])
    expect(html).toContain('id="arrowhead-critical"')
  })
})

describe('findCriticalPath', () => {
  test('returns empty set for no edges', () => {
    const result = findCriticalPath([], new Set(['a']))
    expect(result.size).toBe(0)
  })

  test('returns empty set for no nodes', () => {
    const result = findCriticalPath([['a', 'b']], new Set())
    expect(result.size).toBe(0)
  })

  test('linear chain A->B->C marks all edges critical', () => {
    const edges: Array<[string, string]> = [
      ['a', 'b'],
      ['b', 'c'],
    ]
    const nodes = new Set(['a', 'b', 'c'])
    const result = findCriticalPath(edges, nodes)
    expect(result.has('a->b')).toBe(true)
    expect(result.has('b->c')).toBe(true)
    expect(result.size).toBe(2)
  })

  test('diamond graph marks longest path', () => {
    // A -> B -> D
    // A -> C -> D
    // Both paths are length 2, critical path picks one full path
    const edges: Array<[string, string]> = [
      ['a', 'b'],
      ['a', 'c'],
      ['b', 'd'],
      ['c', 'd'],
    ]
    const nodes = new Set(['a', 'b', 'c', 'd'])
    const result = findCriticalPath(edges, nodes)
    // Should be exactly 2 edges forming one path of length 2
    expect(result.size).toBe(2)
    // The path must end at d and start at a
    const edgeArr = [...result]
    const targets = edgeArr.map((e) => e.split('->')[1])
    expect(targets).toContain('d')
    const sources = edgeArr.map((e) => e.split('->')[0])
    expect(sources).toContain('a')
  })

  test('longer branch is selected as critical', () => {
    // A -> B -> C -> D  (length 3)
    // A -> E -> D       (length 2)
    const edges: Array<[string, string]> = [
      ['a', 'b'],
      ['b', 'c'],
      ['c', 'd'],
      ['a', 'e'],
      ['e', 'd'],
    ]
    const nodes = new Set(['a', 'b', 'c', 'd', 'e'])
    const result = findCriticalPath(edges, nodes)
    expect(result.has('a->b')).toBe(true)
    expect(result.has('b->c')).toBe(true)
    expect(result.has('c->d')).toBe(true)
    expect(result.size).toBe(3)
  })

  test('disconnected subgraphs: critical path on longest', () => {
    // Subgraph 1: x -> y (length 1)
    // Subgraph 2: a -> b -> c (length 2)
    const edges: Array<[string, string]> = [
      ['x', 'y'],
      ['a', 'b'],
      ['b', 'c'],
    ]
    const nodes = new Set(['x', 'y', 'a', 'b', 'c'])
    const result = findCriticalPath(edges, nodes)
    expect(result.has('a->b')).toBe(true)
    expect(result.has('b->c')).toBe(true)
    expect(result.size).toBe(2)
  })

  test('single edge is critical', () => {
    const edges: Array<[string, string]> = [['a', 'b']]
    const nodes = new Set(['a', 'b'])
    const result = findCriticalPath(edges, nodes)
    expect(result.has('a->b')).toBe(true)
    expect(result.size).toBe(1)
  })
})
