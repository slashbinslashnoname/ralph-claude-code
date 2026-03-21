import { describe, test, expect, vi } from 'vitest'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createRoot } from 'react-dom/client'
import { act } from 'react'
import KanbanBoard from './KanbanBoard'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

function render(beads: any[], props?: Partial<{ selectedBeadId: string | null; onSelectBead: (id: string) => void }>): string {
  return renderToStaticMarkup(<KanbanBoard beads={beads} {...props} />)
}

function countOccurrences(html: string, pattern: string): number {
  return html.split(pattern).length - 1
}

describe('KanbanBoard', () => {
  test('renders three columns', () => {
    const html = render([])
    expect(countOccurrences(html, 'data-testid="kanban-column"')).toBe(3)
    expect(html).toContain('Open')
    expect(html).toContain('In Progress')
    expect(html).toContain('Closed')
  })

  test('renders board container with data-testid', () => {
    const html = render([])
    expect(html).toContain('data-testid="kanban-board"')
  })

  test('shows "No beads" in empty columns', () => {
    const html = render([])
    expect(countOccurrences(html, 'data-testid="kanban-empty"')).toBe(3)
  })

  test('places ready beads in Open column', () => {
    const beads = [
      { id: 'a', title: 'Task A', status: 'ready', type: 'task', priority: 2 },
    ]
    const html = render(beads)
    expect(countOccurrences(html, 'data-testid="kanban-card"')).toBe(1)
    expect(html).toContain('Task A')
  })

  test('places pending beads in Open column', () => {
    const beads = [
      { id: 'a', title: 'Pending Task', status: 'pending', type: 'task', priority: 2 },
    ]
    const html = render(beads)
    expect(countOccurrences(html, 'data-testid="kanban-card"')).toBe(1)
    expect(html).toContain('Pending Task')
  })

  test('places claimed beads in In Progress column', () => {
    const beads = [
      { id: 'a', title: 'Active', status: 'claimed', type: 'task', priority: 1 },
    ]
    const html = render(beads)
    expect(html).toContain('Active')
    expect(html).toContain('in progress')
  })

  test('places done beads in Closed column', () => {
    const beads = [
      { id: 'a', title: 'Finished', status: 'done', type: 'task', priority: 2 },
    ]
    const html = render(beads)
    expect(html).toContain('Finished')
    expect(html).toContain('closed')
  })

  test('places failed beads in Closed column', () => {
    const beads = [
      { id: 'a', title: 'Broken', status: 'failed', type: 'bug', priority: 0 },
    ]
    const html = render(beads)
    expect(html).toContain('Broken')
    expect(html).toContain('failed')
  })

  test('distributes beads across columns', () => {
    const beads = [
      { id: 'a', title: 'Open One', status: 'ready', type: 'task', priority: 2 },
      { id: 'b', title: 'WIP', status: 'claimed', type: 'task', priority: 1 },
      { id: 'c', title: 'Done One', status: 'done', type: 'task', priority: 3 },
    ]
    const html = render(beads)
    expect(countOccurrences(html, 'data-testid="kanban-card"')).toBe(3)
  })

  test('shows column counts', () => {
    const beads = [
      { id: 'a', title: 'A', status: 'ready', type: 'task', priority: 2 },
      { id: 'b', title: 'B', status: 'ready', type: 'task', priority: 2 },
      { id: 'c', title: 'C', status: 'claimed', type: 'task', priority: 1 },
    ]
    const html = render(beads)
    // The count badges show the number
    expect(html).toContain('>2<')
    expect(html).toContain('>1<')
  })

  test('displays bead id and type', () => {
    const beads = [
      { id: 'sb-100', title: 'Task', status: 'ready', type: 'feature', priority: 2 },
    ]
    const html = render(beads)
    expect(html).toContain('sb-100')
    expect(html).toContain('feature')
  })

  test('truncates long descriptions', () => {
    const longDesc = 'x'.repeat(200)
    const beads = [
      { id: 'a', title: 'T', status: 'ready', type: 'task', priority: 2, description: longDesc },
    ]
    const html = render(beads)
    expect(html).toContain('...')
    expect(html).not.toContain('x'.repeat(200))
  })

  test('selected card gets kanban-card-selected class', () => {
    const beads = [
      { id: 'a', title: 'A', status: 'ready', type: 'task', priority: 2 },
    ]
    const html = render(beads, { selectedBeadId: 'a' })
    expect(html).toContain('kanban-card-selected')
  })

  test('epic card gets kanban-card-epic class', () => {
    const beads = [
      { id: 'epic-1', title: 'Epic', status: 'ready', type: 'epic', priority: 1 },
    ]
    const html = render(beads)
    expect(html).toContain('kanban-card-epic')
  })

  // ── Hierarchy tests ──

  test('epic with children shows sub-items', () => {
    const beads = [
      { id: 'epic-1', title: 'Epic', status: 'ready', type: 'epic', priority: 1 },
      { id: 'task-1', title: 'Child Task', status: 'ready', type: 'task', priority: 2, epicId: 'epic-1' },
    ]
    const html = render(beads)
    expect(html).toContain('data-testid="kanban-children"')
    expect(html).toContain('Child Task')
    expect(html).toContain('1 sub-item')
  })

  test('children are nested inside parent, not shown as top-level cards', () => {
    const beads = [
      { id: 'epic-1', title: 'Epic', status: 'ready', type: 'epic', priority: 1 },
      { id: 'task-1', title: 'Child', status: 'ready', type: 'task', priority: 2, epicId: 'epic-1' },
    ]
    const html = render(beads)
    // Only 1 top-level card (the epic)
    expect(countOccurrences(html, 'data-testid="kanban-card"')).toBe(1)
    // Child shown inline
    expect(countOccurrences(html, 'data-testid="kanban-child"')).toBe(1)
  })

  test('task with subtasks shows subtask count', () => {
    const beads = [
      { id: 'epic-1', title: 'Epic', status: 'ready', type: 'epic', priority: 1 },
      { id: 'task-1', title: 'Task', status: 'ready', type: 'task', priority: 2, epicId: 'epic-1' },
      { id: 'sub-1', title: 'Sub 1', status: 'done', type: 'subtask', priority: 3, epicId: 'task-1' },
      { id: 'sub-2', title: 'Sub 2', status: 'ready', type: 'subtask', priority: 3, epicId: 'task-1' },
    ]
    const html = render(beads)
    expect(html).toContain('data-testid="kanban-subtask-count"')
    // 1 done out of 2
    expect(html).toContain('1/2')
  })

  test('pluralizes sub-items label', () => {
    const beads = [
      { id: 'e', title: 'Epic', status: 'ready', type: 'epic', priority: 1 },
      { id: 't1', title: 'T1', status: 'ready', type: 'task', priority: 2, epicId: 'e' },
      { id: 't2', title: 'T2', status: 'ready', type: 'task', priority: 2, epicId: 'e' },
    ]
    const html = render(beads)
    expect(html).toContain('2 sub-items')
  })

  test('orphan beads (epicId not found) appear as top-level', () => {
    const beads = [
      { id: 'a', title: 'Orphan', status: 'ready', type: 'task', priority: 2, epicId: 'nonexistent' },
    ]
    const html = render(beads)
    expect(countOccurrences(html, 'data-testid="kanban-card"')).toBe(1)
  })

  test('shows claimedBy as agent tag', () => {
    const beads = [
      { id: 'a', title: 'T', status: 'claimed', type: 'task', priority: 1, claimedBy: 'agent-0' },
    ]
    const html = render(beads)
    expect(html).toContain('agent-0')
    expect(html).toContain('tag-agent')
  })

  // ── Interactive tests ──

  test('onSelectBead fires when clicking card title', () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    try {
      const callback = vi.fn()
      const beads = [
        { id: 'a', title: 'Task A', status: 'ready', type: 'task', priority: 2 },
      ]
      const root = createRoot(container)
      act(() => { root.render(<KanbanBoard beads={beads} onSelectBead={callback} />) })

      const title = container.querySelector('[data-testid="kanban-card-title"]') as HTMLElement
      act(() => { title.click() })

      expect(callback).toHaveBeenCalledTimes(1)
      expect(callback).toHaveBeenCalledWith('a')

      act(() => { root.unmount() })
    } finally {
      document.body.removeChild(container)
    }
  })

  test('onSelectBead fires when clicking child title', () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    try {
      const callback = vi.fn()
      const beads = [
        { id: 'e', title: 'Epic', status: 'ready', type: 'epic', priority: 1 },
        { id: 't', title: 'Task', status: 'ready', type: 'task', priority: 2, epicId: 'e' },
      ]
      const root = createRoot(container)
      act(() => { root.render(<KanbanBoard beads={beads} onSelectBead={callback} />) })

      const childTitle = container.querySelector('[data-testid="kanban-child-title"]') as HTMLElement
      act(() => { childTitle.click() })

      expect(callback).toHaveBeenCalledWith('t')

      act(() => { root.unmount() })
    } finally {
      document.body.removeChild(container)
    }
  })

  test('onClaimBead fires on Claim button click', () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    try {
      const onClaim = vi.fn()
      const beads = [
        { id: 'a', title: 'A', status: 'ready', type: 'task', priority: 2 },
      ]
      const root = createRoot(container)
      act(() => { root.render(<KanbanBoard beads={beads} onClaimBead={onClaim} />) })

      const btn = Array.from(container.querySelectorAll('button')).find(b => b.textContent === 'Claim')!
      act(() => { btn.click() })

      expect(onClaim).toHaveBeenCalledWith('a')

      act(() => { root.unmount() })
    } finally {
      document.body.removeChild(container)
    }
  })
})

describe('KanbanBoard CSS styles', () => {
  const fs = require('fs')
  const path = require('path')
  const css: string = fs.readFileSync(
    path.resolve(__dirname, '../styles.css'),
    'utf-8',
  )

  test('.kanban-board has grid layout', () => {
    expect(css).toContain('.kanban-board')
    expect(css).toMatch(/\.kanban-board\s*\{[^}]*display:\s*grid/)
    expect(css).toMatch(/\.kanban-board\s*\{[^}]*grid-template-columns:\s*repeat\(3/)
  })

  test('.kanban-column has flex column layout', () => {
    expect(css).toContain('.kanban-column')
    expect(css).toMatch(/\.kanban-column\s*\{[^}]*display:\s*flex/)
    expect(css).toMatch(/\.kanban-column\s*\{[^}]*flex-direction:\s*column/)
  })

  test('.kanban-card has background and border', () => {
    expect(css).toContain('.kanban-card')
    expect(css).toMatch(/\.kanban-card\s*\{[^}]*background:\s*var\(--bg-card\)/)
    expect(css).toMatch(/\.kanban-card\s*\{[^}]*border:\s*1px solid var\(--border\)/)
  })

  test('.kanban-card-selected has accent border', () => {
    expect(css).toContain('.kanban-card-selected')
    expect(css).toMatch(/\.kanban-card-selected\s*\{[^}]*border-color:\s*var\(--accent\)/)
  })

  test('.kanban-card-epic has accent left border', () => {
    expect(css).toContain('.kanban-card-epic')
    expect(css).toMatch(/\.kanban-card-epic\s*\{[^}]*border-left:\s*3px solid var\(--accent\)/)
  })

  test('kanban status color classes exist', () => {
    expect(css).toMatch(/\.kanban-status-done\s*\{[^}]*color:\s*var\(--success\)/)
    expect(css).toMatch(/\.kanban-status-failed\s*\{[^}]*color:\s*var\(--danger\)/)
    expect(css).toMatch(/\.kanban-status-claimed\s*\{[^}]*color:\s*var\(--warning\)/)
    expect(css).toMatch(/\.kanban-status-ready\s*\{[^}]*color:\s*var\(--info\)/)
    expect(css).toMatch(/\.kanban-status-pending\s*\{[^}]*color:\s*var\(--text-2\)/)
  })
})
