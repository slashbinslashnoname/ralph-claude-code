import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createRoot } from 'react-dom/client'
import { act } from 'react'
import DependencyDAG, { DAGBead, findCriticalPath } from './DependencyDAG'

// Enable React act() environment for jsdom
;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

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

  test('status colors are applied via CSS class and data-status attribute', () => {
    const statuses: Array<DAGBead['status']> = ['pending', 'ready', 'claimed', 'done', 'failed']

    for (const status of statuses) {
      const beads: DAGBead[] = [{ id: `s-${status}`, title: status, status, deps: [] }]
      const html = render(beads)
      expect(html).toContain('class="dag-node"')
      expect(html).toContain(`data-status="${status}"`)
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

  test('selected node gets dag-node-selected class', () => {
    const beads: DAGBead[] = [
      { id: 'a', title: 'Task A', status: 'ready', deps: [] },
      { id: 'b', title: 'Task B', status: 'done', deps: ['a'] },
    ]
    const html = renderToStaticMarkup(
      <DependencyDAG beads={beads} selectedBeadId="a" onSelectBead={() => {}} />
    )
    expect(html).toContain('dag-node-selected')
  })

  test('unselected nodes do not get dag-node-selected class', () => {
    const beads: DAGBead[] = [
      { id: 'a', title: 'Task A', status: 'ready', deps: [] },
    ]
    const html = renderToStaticMarkup(
      <DependencyDAG beads={beads} selectedBeadId="nonexistent" onSelectBead={() => {}} />
    )
    expect(html).not.toContain('dag-node-selected')
  })

  test('nodes have pointer cursor when onSelectBead is provided', () => {
    const beads: DAGBead[] = [
      { id: 'a', title: 'Task A', status: 'ready', deps: [] },
    ]
    const html = renderToStaticMarkup(
      <DependencyDAG beads={beads} onSelectBead={() => {}} />
    )
    expect(html).toContain('cursor:pointer')
  })

  test('renders without selectedBeadId/onSelectBead (backward compat)', () => {
    const beads: DAGBead[] = [
      { id: 'a', title: 'Task A', status: 'ready', deps: [] },
    ]
    const html = render(beads)
    expect(html).toContain('data-testid="dag-node"')
    expect(html).not.toContain('dag-node-selected')
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

  test('critical edges use dag-edge and dag-critical CSS classes', () => {
    const beads: DAGBead[] = [
      { id: 'a', title: 'A', status: 'ready', deps: [] },
      { id: 'b', title: 'B', status: 'pending', deps: ['a'] },
      { id: 'c', title: 'C', status: 'pending', deps: ['b'] },
    ]
    const html = render(beads)
    // Critical path edges get both classes; styling comes from CSS
    expect(html).toContain('class="dag-edge dag-critical"')
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

  test('onSelectBead callback fires with correct bead id on click', () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    try {
      const callback = vi.fn()
      const beads: DAGBead[] = [
        { id: 'click-a', title: 'Click A', status: 'ready', deps: [] },
        { id: 'click-b', title: 'Click B', status: 'pending', deps: ['click-a'] },
      ]

      const root = createRoot(container)
      act(() => {
        root.render(<DependencyDAG beads={beads} onSelectBead={callback} />)
      })

      const nodes = container.querySelectorAll('[data-testid="dag-node"]')
      expect(nodes.length).toBe(2)

      // Click the first node rect — event bubbles to <g> onClick handler
      act(() => {
        nodes[0].dispatchEvent(new MouseEvent('click', { bubbles: true }))
      })

      expect(callback).toHaveBeenCalledTimes(1)
      expect(callback).toHaveBeenCalledWith('click-a')

      act(() => {
        root.unmount()
      })
    } finally {
      document.body.removeChild(container)
    }
  })
})

describe('DAG CSS styles', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const fs = require('fs')
  const path = require('path')
  const css: string = fs.readFileSync(
    path.resolve(__dirname, '../styles.css'),
    'utf-8',
  )

  test('.dag-container has width, min-height, and card background', () => {
    expect(css).toContain('.dag-container')
    expect(css).toMatch(/\.dag-container\s*\{[^}]*width:\s*100%/)
    expect(css).toMatch(/\.dag-container\s*\{[^}]*min-height:\s*400px/)
    expect(css).toMatch(/\.dag-container\s*\{[^}]*background:\s*var\(--bg-card\)/)
  })

  test('.dag-node status selectors use CSS custom properties', () => {
    expect(css).toMatch(/\.dag-node\[data-status="done"\]\s*\{[^}]*fill:\s*var\(--success\)/)
    expect(css).toMatch(/\.dag-node\[data-status="failed"\]\s*\{[^}]*fill:\s*var\(--danger\)/)
    expect(css).toMatch(/\.dag-node\[data-status="claimed"\]\s*\{[^}]*fill:\s*var\(--warning\)/)
    expect(css).toMatch(/\.dag-node\[data-status="ready"\]\s*\{[^}]*fill:\s*var\(--info\)/)
    expect(css).toMatch(/\.dag-node\[data-status="pending"\]\s*\{[^}]*fill:\s*var\(--text-2\)/)
  })

  test('.dag-edge has stroke styles', () => {
    expect(css).toContain('.dag-edge')
    expect(css).toMatch(/\.dag-edge\s*\{[^}]*stroke:\s*var\(--text-2\)/)
    expect(css).toMatch(/\.dag-edge\s*\{[^}]*stroke-width:\s*1\.5/)
  })

  test('.dag-critical has thicker stroke and brightness filter', () => {
    expect(css).toContain('.dag-critical')
    expect(css).toMatch(/\.dag-critical\s*\{[^}]*stroke-width:\s*3/)
    expect(css).toMatch(/\.dag-critical\s*\{[^}]*filter:\s*brightness/)
  })

  test('.dag-node-selected has accent stroke', () => {
    expect(css).toContain('.dag-node-selected')
    expect(css).toMatch(/\.dag-node-selected\s*\{[^}]*stroke:\s*var\(--accent/)
    expect(css).toMatch(/\.dag-node-selected\s*\{[^}]*stroke-width:\s*3/)
  })

  test('.dag-label matches bead-title font', () => {
    expect(css).toContain('.dag-label')
    expect(css).toMatch(/\.dag-label\s*\{[^}]*font-size:\s*14px/)
    expect(css).toMatch(/\.dag-label\s*\{[^}]*font-weight:\s*500/)
  })

  test('.view-toggle button group styling', () => {
    expect(css).toContain('.view-toggle')
    expect(css).toMatch(/\.view-toggle\s*\{[^}]*display:\s*inline-flex/)
    expect(css).toContain('.view-toggle button')
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
