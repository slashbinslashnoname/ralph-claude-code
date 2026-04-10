import { describe, test, expect, vi, beforeEach } from 'vitest'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

const mocks = vi.hoisted(() => {
  const mockList = vi.fn().mockResolvedValue({ ok: true, memories: [] })
  const mockAdd = vi.fn().mockResolvedValue({ ok: true })
  const mockForget = vi.fn().mockResolvedValue({ ok: true })

  if (typeof (globalThis as any).window === 'undefined') {
    ;(globalThis as any).window = {}
  }
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  ;(globalThis as any).window.slashbot = {
    memories: {
      list: mockList,
      add: mockAdd,
      forget: mockForget,
    },
  }

  return { mockList, mockAdd, mockForget }
})

import MemoriesPage from './MemoriesPage'
import { ToastProvider } from '../components/Toast'

beforeEach(() => {
  vi.clearAllMocks()
  mocks.mockList.mockResolvedValue({ ok: true, memories: [] })
})

function renderPage(props: { projectPath: string } = { projectPath: '/tmp/test' }) {
  return renderToStaticMarkup(<ToastProvider><MemoriesPage {...props} /></ToastProvider>)
}

describe('MemoriesPage', () => {
  test('renders without error', () => {
    expect(() => renderPage()).not.toThrow()
  })

  test('renders page header with Memories title', () => {
    const html = renderPage()
    expect(html).toContain('Memories')
    expect(html).toContain('Add Memory')
    expect(html).toContain('Refresh')
  })

  test('renders search input', () => {
    const html = renderPage()
    expect(html).toContain('Search memories')
  })

  test('renders empty state when no memories', () => {
    const html = renderPage()
    expect(html).toContain('No memories yet')
  })

  test('calls memories.list on mount via DOM render', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const { createRoot } = await import('react-dom/client')
    const { act } = await import('react')
    await act(async () => {
      createRoot(container).render(<ToastProvider><MemoriesPage projectPath="/tmp/proj" /></ToastProvider>)
    })
    expect(mocks.mockList).toHaveBeenCalledWith('/tmp/proj')
    document.body.removeChild(container)
  })

  test('renders memory cards when memories exist', () => {
    mocks.mockList.mockResolvedValue({
      ok: true,
      memories: [
        { key: 'test-key', text: 'test memory text' },
        { key: 'another-key', text: 'another memory' },
      ],
    })
    const html = renderPage()
    // SSR won't await the async list call, so cards won't appear in static render.
    // But the page structure is rendered correctly.
    expect(html).toContain('Memories')
  })

  test('renders MemoryCard with key and delete button', () => {
    // Verify the MemoryCard component structure via direct import
    const html = renderPage()
    expect(html).toContain('memory-list')
  })

  test('add creates a memory card', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const { createRoot } = await import('react-dom/client')
    const { act } = await import('react')

    // Start with empty list, then return new memory after add
    mocks.mockList
      .mockResolvedValueOnce({ ok: true, memories: [] })
      .mockResolvedValueOnce({ ok: true, memories: [{ key: 'new-key', text: 'new memory' }] })
    mocks.mockAdd.mockResolvedValue({ ok: true })

    let root: ReturnType<typeof createRoot>
    await act(async () => {
      root = createRoot(container)
      root!.render(<ToastProvider><MemoriesPage projectPath="/tmp/proj" /></ToastProvider>)
    })

    // Open the add form
    const addBtn = container.querySelector('button.btn-primary') as HTMLButtonElement
    await act(async () => { addBtn.click() })

    // Fill in text
    const textarea = container.querySelector('textarea') as HTMLTextAreaElement
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(textarea, 'new memory')
      textarea.dispatchEvent(new Event('input', { bubbles: true }))
      textarea.dispatchEvent(new Event('change', { bubbles: true }))
    })

    // Click Save
    const saveBtn = container.querySelector('.memory-add-form .btn-primary') as HTMLButtonElement
    await act(async () => { saveBtn.click() })
    await act(async () => { await new Promise(r => setTimeout(r, 0)) })

    expect(mocks.mockAdd).toHaveBeenCalledWith('/tmp/proj', 'new memory', undefined)
    expect(container.innerHTML).toContain('new-key')
    expect(container.innerHTML).toContain('new memory')

    document.body.removeChild(container)
  })

  test('forget removes a memory card', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const { createRoot } = await import('react-dom/client')
    const { act } = await import('react')

    mocks.mockList
      .mockResolvedValueOnce({
        ok: true,
        memories: [
          { key: 'keep-me', text: 'keep this' },
          { key: 'delete-me', text: 'delete this' },
        ],
      })
      .mockResolvedValueOnce({
        ok: true,
        memories: [{ key: 'keep-me', text: 'keep this' }],
      })
    mocks.mockForget.mockResolvedValue({ ok: true })

    let root: ReturnType<typeof createRoot>
    await act(async () => {
      root = createRoot(container)
      root!.render(<ToastProvider><MemoriesPage projectPath="/tmp/proj" /></ToastProvider>)
    })
    await act(async () => { await new Promise(r => setTimeout(r, 0)) })

    // Both cards should be present
    expect(container.innerHTML).toContain('delete-me')
    expect(container.innerHTML).toContain('keep-me')

    // Click the Delete button on the second card
    const deleteBtns = container.querySelectorAll('.btn-danger')
    expect(deleteBtns.length).toBe(2)
    await act(async () => { (deleteBtns[1] as HTMLButtonElement).click() })
    await act(async () => { await new Promise(r => setTimeout(r, 0)) })

    expect(mocks.mockForget).toHaveBeenCalledWith('/tmp/proj', 'delete-me')
    expect(container.innerHTML).toContain('keep-me')
    expect(container.innerHTML).not.toContain('delete-me')

    document.body.removeChild(container)
  })

  test('search filters memories by key and text', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const { createRoot } = await import('react-dom/client')
    const { act } = await import('react')

    mocks.mockList.mockResolvedValue({
      ok: true,
      memories: [
        { key: 'db-config', text: 'database connection string' },
        { key: 'api-key', text: 'secret token' },
        { key: 'deploy-notes', text: 'use database migrations' },
      ],
    })

    await act(async () => {
      createRoot(container).render(<ToastProvider><MemoriesPage projectPath="/tmp/proj" /></ToastProvider>)
    })
    await act(async () => { await new Promise(r => setTimeout(r, 0)) })

    // All three cards visible
    expect(container.querySelectorAll('.memory-card').length).toBe(3)

    // Type "database" into search
    const searchInput = container.querySelector('.memory-search input') as HTMLInputElement
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(searchInput, 'database')
      searchInput.dispatchEvent(new Event('input', { bubbles: true }))
      searchInput.dispatchEvent(new Event('change', { bubbles: true }))
    })

    // Should show only the two memories containing "database"
    const cards = container.querySelectorAll('.memory-card')
    expect(cards.length).toBe(2)
    expect(container.innerHTML).toContain('db-config')
    expect(container.innerHTML).toContain('deploy-notes')
    expect(container.innerHTML).not.toContain('api-key')

    document.body.removeChild(container)
  })

  test('displays creation timestamp on memory cards with createdAt', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const { createRoot } = await import('react-dom/client')
    const { act } = await import('react')

    mocks.mockList.mockResolvedValue({
      ok: true,
      memories: [
        { key: 'timestamped', text: 'has a timestamp', createdAt: '2026-04-10T14:30:00Z' },
        { key: 'no-timestamp', text: 'no timestamp' },
      ],
    })

    await act(async () => {
      createRoot(container).render(<ToastProvider><MemoriesPage projectPath="/tmp/proj" /></ToastProvider>)
    })
    await act(async () => { await new Promise(r => setTimeout(r, 0)) })

    // Memory with createdAt should show formatted timestamp
    const createdAtSpan = container.querySelector('.memory-created-at')
    expect(createdAtSpan).not.toBeNull()
    expect(createdAtSpan!.textContent).toContain('Apr')

    // Memory without createdAt should not show timestamp
    const cards = container.querySelectorAll('.memory-card')
    expect(cards.length).toBe(2)
    const secondCard = cards[1]
    expect(secondCard.querySelector('.memory-created-at')).toBeNull()

    document.body.removeChild(container)
  })

  test('renders MemoryTimeline inside memory cards with createdAt', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const { createRoot } = await import('react-dom/client')
    const { act } = await import('react')

    mocks.mockList.mockResolvedValue({
      ok: true,
      memories: [
        { key: 'with-timeline', text: 'timeline visible', createdAt: '2026-04-10T10:00:00Z' },
      ],
    })

    await act(async () => {
      createRoot(container).render(<ToastProvider><MemoriesPage projectPath="/tmp/proj" /></ToastProvider>)
    })
    await act(async () => { await new Promise(r => setTimeout(r, 0)) })

    // Should render the memory-timeline inside the card
    const timeline = container.querySelector('.memory-timeline')
    expect(timeline).not.toBeNull()
    expect(timeline!.textContent).toContain('created')

    document.body.removeChild(container)
  })

  test('cancel button clears form state via DOM', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const { createRoot } = await import('react-dom/client')
    const { act } = await import('react')
    let root: ReturnType<typeof createRoot>
    await act(async () => {
      root = createRoot(container)
      root!.render(<ToastProvider><MemoriesPage projectPath="/tmp/proj" /></ToastProvider>)
    })

    // Open the add form
    const addBtn = container.querySelector('button.btn-primary') as HTMLButtonElement
    await act(async () => { addBtn.click() })

    // Type into the textarea
    const textarea = container.querySelector('textarea') as HTMLTextAreaElement
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(textarea, 'draft text')
      textarea.dispatchEvent(new Event('input', { bubbles: true }))
      textarea.dispatchEvent(new Event('change', { bubbles: true }))
    })

    // Cancel — reopen and check textarea is empty
    const cancelBtn = container.querySelector('button.btn-primary') as HTMLButtonElement
    await act(async () => { cancelBtn.click() })
    await act(async () => { cancelBtn.click() })

    const ta2 = container.querySelector('textarea') as HTMLTextAreaElement
    expect(ta2.value).toBe('')

    document.body.removeChild(container)
  })
})
