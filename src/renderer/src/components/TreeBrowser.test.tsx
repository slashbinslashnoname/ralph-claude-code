import { describe, test, expect, vi } from 'vitest'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createRoot } from 'react-dom/client'
import { act } from 'react'
import TreeBrowser from './TreeBrowser'
import type { DAGBead } from './DependencyDAG'

// Enable React act() environment for jsdom
;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

function render(beads: DAGBead[], props?: Partial<{ selectedBeadId: string | null; onSelectBead: (id: string) => void }>): string {
  return renderToStaticMarkup(<TreeBrowser beads={beads} {...props} />)
}

function countOccurrences(html: string, pattern: string): number {
  return html.split(pattern).length - 1
}

describe('TreeBrowser', () => {
  test('renders container with data-testid', () => {
    const html = render([])
    expect(html).toContain('data-testid="tree-browser"')
  })

  test('renders breadcrumb with Root', () => {
    const html = render([])
    expect(html).toContain('data-testid="tree-breadcrumb"')
    expect(html).toContain('Root')
  })

  test('shows "No beads" when empty', () => {
    const html = render([])
    expect(html).toContain('No beads')
  })

  test('renders root nodes (no parents)', () => {
    const beads: DAGBead[] = [
      { id: 'a', title: 'Root A', status: 'ready', deps: [] },
      { id: 'b', title: 'Root B', status: 'done', deps: [] },
    ]
    const html = render(beads)
    expect(countOccurrences(html, 'data-testid="tree-node"')).toBe(2)
    expect(html).toContain('Root A')
    expect(html).toContain('Root B')
  })

  test('child nodes are not shown at root level', () => {
    const beads: DAGBead[] = [
      { id: 'parent', title: 'Parent', status: 'ready', deps: [] },
      { id: 'child', title: 'Child', status: 'pending', deps: ['parent'] },
    ]
    const html = render(beads)
    // Only parent shown at root
    expect(countOccurrences(html, 'data-testid="tree-node"')).toBe(1)
    expect(html).toContain('Parent')
    expect(html).not.toContain('Child')
  })

  test('parent node shows expand button with child count', () => {
    const beads: DAGBead[] = [
      { id: 'p', title: 'Parent', status: 'ready', deps: [] },
      { id: 'c1', title: 'Child 1', status: 'pending', deps: ['p'] },
      { id: 'c2', title: 'Child 2', status: 'pending', deps: ['p'] },
    ]
    const html = render(beads)
    expect(html).toContain('data-testid="tree-node-expand"')
    expect(html).toContain('2')
  })

  test('leaf nodes do not show expand button', () => {
    const beads: DAGBead[] = [
      { id: 'leaf', title: 'Leaf', status: 'ready', deps: [] },
    ]
    const html = render(beads)
    expect(html).not.toContain('data-testid="tree-node-expand"')
  })

  test('displays bead id', () => {
    const beads: DAGBead[] = [
      { id: 'abc-123', title: 'Task', status: 'ready', deps: [] },
    ]
    const html = render(beads)
    expect(html).toContain('abc-123')
  })

  test('status classes are applied', () => {
    const statuses: Array<DAGBead['status']> = ['pending', 'ready', 'claimed', 'done', 'failed']
    for (const status of statuses) {
      const beads: DAGBead[] = [{ id: `s-${status}`, title: status, status, deps: [] }]
      const html = render(beads)
      expect(html).toContain(`tree-status-${status}`)
      expect(html).toContain(`data-status="${status}"`)
    }
  })

  test('selected node gets tree-node-selected class', () => {
    const beads: DAGBead[] = [
      { id: 'a', title: 'Task A', status: 'ready', deps: [] },
    ]
    const html = render(beads, { selectedBeadId: 'a' })
    expect(html).toContain('tree-node-selected')
  })

  test('unselected nodes do not get tree-node-selected class', () => {
    const beads: DAGBead[] = [
      { id: 'a', title: 'Task A', status: 'ready', deps: [] },
    ]
    const html = render(beads, { selectedBeadId: 'other' })
    expect(html).not.toContain('tree-node-selected')
  })

  test('epicId creates parent-child relationship', () => {
    const beads: DAGBead[] = [
      { id: 'epic-1', title: 'Epic', status: 'ready', deps: [] },
      { id: 'task-1', title: 'Task', status: 'pending', deps: [], epicId: 'epic-1' },
    ]
    const html = render(beads)
    // Only epic shown at root, task is a child
    expect(countOccurrences(html, 'data-testid="tree-node"')).toBe(1)
    expect(html).toContain('Epic')
    expect(html).not.toContain('>Task<')
  })

  test('missing dep does not hide node from root', () => {
    const beads: DAGBead[] = [
      { id: 'a', title: 'Orphan', status: 'ready', deps: ['nonexistent'] },
    ]
    const html = render(beads)
    expect(countOccurrences(html, 'data-testid="tree-node"')).toBe(1)
    expect(html).toContain('Orphan')
  })

  // ── Interactive tests using createRoot + act ──

  test('clicking expand drills down to show children', () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    try {
      const beads: DAGBead[] = [
        { id: 'p', title: 'Parent', status: 'ready', deps: [] },
        { id: 'c1', title: 'Child 1', status: 'pending', deps: ['p'] },
        { id: 'c2', title: 'Child 2', status: 'claimed', deps: ['p'] },
      ]

      const root = createRoot(container)
      act(() => { root.render(<TreeBrowser beads={beads} />) })

      // Initially only parent visible
      let nodes = container.querySelectorAll('[data-testid="tree-node"]')
      expect(nodes.length).toBe(1)

      // Click expand
      const expandBtn = container.querySelector('[data-testid="tree-node-expand"]') as HTMLButtonElement
      expect(expandBtn).not.toBeNull()
      act(() => { expandBtn.click() })

      // Now children are visible
      nodes = container.querySelectorAll('[data-testid="tree-node"]')
      expect(nodes.length).toBe(2)
      expect(container.textContent).toContain('Child 1')
      expect(container.textContent).toContain('Child 2')

      // Breadcrumb should show parent
      const crumbs = container.querySelectorAll('[data-testid="tree-crumb"]')
      expect(crumbs.length).toBe(1)
      expect(crumbs[0].textContent).toBe('Parent')

      act(() => { root.unmount() })
    } finally {
      document.body.removeChild(container)
    }
  })

  test('clicking Root breadcrumb navigates back to roots', () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    try {
      const beads: DAGBead[] = [
        { id: 'p', title: 'Parent', status: 'ready', deps: [] },
        { id: 'c', title: 'Child', status: 'pending', deps: ['p'] },
      ]

      const root = createRoot(container)
      act(() => { root.render(<TreeBrowser beads={beads} />) })

      // Drill down
      const expandBtn = container.querySelector('[data-testid="tree-node-expand"]') as HTMLButtonElement
      act(() => { expandBtn.click() })
      expect(container.textContent).toContain('Child')

      // Click Root
      const rootCrumb = container.querySelector('[data-testid="tree-crumb-root"]') as HTMLButtonElement
      act(() => { rootCrumb.click() })

      // Back to root level
      const nodes = container.querySelectorAll('[data-testid="tree-node"]')
      expect(nodes.length).toBe(1)
      expect(container.textContent).toContain('Parent')

      act(() => { root.unmount() })
    } finally {
      document.body.removeChild(container)
    }
  })

  test('onSelectBead fires when clicking node title', () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    try {
      const callback = vi.fn()
      const beads: DAGBead[] = [
        { id: 'a', title: 'Task A', status: 'ready', deps: [] },
      ]

      const root = createRoot(container)
      act(() => { root.render(<TreeBrowser beads={beads} onSelectBead={callback} />) })

      const title = container.querySelector('[data-testid="tree-node-title"]') as HTMLElement
      act(() => { title.click() })

      expect(callback).toHaveBeenCalledTimes(1)
      expect(callback).toHaveBeenCalledWith('a')

      act(() => { root.unmount() })
    } finally {
      document.body.removeChild(container)
    }
  })

  test('shows "No children" when drilled into a leaf-like node via multi-level navigation', () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    try {
      const beads: DAGBead[] = [
        { id: 'a', title: 'A', status: 'ready', deps: [] },
        { id: 'b', title: 'B', status: 'pending', deps: ['a'] },
        { id: 'c', title: 'C', status: 'pending', deps: ['b'] },
      ]

      const root = createRoot(container)
      act(() => { root.render(<TreeBrowser beads={beads} />) })

      // Drill: A -> B
      let expand = container.querySelector('[data-testid="tree-node-expand"]') as HTMLButtonElement
      act(() => { expand.click() })
      expect(container.textContent).toContain('B')

      // Drill: B -> C
      expand = container.querySelector('[data-testid="tree-node-expand"]') as HTMLButtonElement
      act(() => { expand.click() })
      expect(container.textContent).toContain('C')
      // C has no children, no expand button
      expect(container.querySelector('[data-testid="tree-node-expand"]')).toBeNull()

      // Breadcrumb: Root / A / B
      const crumbs = container.querySelectorAll('[data-testid="tree-crumb"]')
      expect(crumbs.length).toBe(2) // A and B
      expect(crumbs[0].textContent).toBe('A')
      expect(crumbs[1].textContent).toBe('B')

      act(() => { root.unmount() })
    } finally {
      document.body.removeChild(container)
    }
  })

  test('clicking intermediate breadcrumb navigates to that level', () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    try {
      const beads: DAGBead[] = [
        { id: 'a', title: 'Level 0', status: 'ready', deps: [] },
        { id: 'b', title: 'Level 1', status: 'pending', deps: ['a'] },
        { id: 'c', title: 'Level 2', status: 'pending', deps: ['b'] },
      ]

      const root = createRoot(container)
      act(() => { root.render(<TreeBrowser beads={beads} />) })

      // Drill A -> B -> C
      let expand = container.querySelector('[data-testid="tree-node-expand"]') as HTMLButtonElement
      act(() => { expand.click() })
      expand = container.querySelector('[data-testid="tree-node-expand"]') as HTMLButtonElement
      act(() => { expand.click() })

      // We're at level 2, breadcrumb: Root / Level 0 / Level 1
      // Click "Level 0" crumb (first tree-crumb)
      const crumbs = container.querySelectorAll('[data-testid="tree-crumb"]')
      act(() => { (crumbs[0] as HTMLButtonElement).click() })

      // Should show Level 1 (child of A)
      expect(container.textContent).toContain('Level 1')
      expect(container.querySelectorAll('[data-testid="tree-crumb"]').length).toBe(1)

      act(() => { root.unmount() })
    } finally {
      document.body.removeChild(container)
    }
  })
})

describe('TreeBrowser CSS styles', () => {
  const fs = require('fs')
  const path = require('path')
  const css: string = fs.readFileSync(
    path.resolve(__dirname, '../styles.css'),
    'utf-8',
  )

  test('.tree-browser has card background and border', () => {
    expect(css).toContain('.tree-browser')
    expect(css).toMatch(/\.tree-browser\s*\{[^}]*background:\s*var\(--bg-card\)/)
    expect(css).toMatch(/\.tree-browser\s*\{[^}]*border:\s*1px solid var\(--border\)/)
  })

  test('.tree-breadcrumb has flex layout', () => {
    expect(css).toContain('.tree-breadcrumb')
    expect(css).toMatch(/\.tree-breadcrumb\s*\{[^}]*display:\s*flex/)
  })

  test('.tree-node has border and padding', () => {
    expect(css).toContain('.tree-node')
    expect(css).toMatch(/\.tree-node\s*\{[^}]*padding/)
    expect(css).toMatch(/\.tree-node\s*\{[^}]*border:\s*1px solid var\(--border\)/)
  })

  test('.tree-node-selected has accent border', () => {
    expect(css).toContain('.tree-node-selected')
    expect(css).toMatch(/\.tree-node-selected\s*\{[^}]*border-color:\s*var\(--accent\)/)
  })

  test('status color classes exist', () => {
    expect(css).toMatch(/\.tree-status-done\s*\{[^}]*color:\s*var\(--success\)/)
    expect(css).toMatch(/\.tree-status-failed\s*\{[^}]*color:\s*var\(--danger\)/)
    expect(css).toMatch(/\.tree-status-claimed\s*\{[^}]*color:\s*var\(--warning\)/)
    expect(css).toMatch(/\.tree-status-ready\s*\{[^}]*color:\s*var\(--info\)/)
    expect(css).toMatch(/\.tree-status-pending\s*\{[^}]*color:\s*var\(--text-2\)/)
  })
})
