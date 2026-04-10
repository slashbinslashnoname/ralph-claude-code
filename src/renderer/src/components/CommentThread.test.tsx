import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createRoot } from 'react-dom/client'
import { act } from 'react'

// Enable React act() environment for jsdom
;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const mockComments = vi.fn().mockResolvedValue([])
const mockAddComment = vi.fn().mockResolvedValue({ ok: true })

// The component reads window.slashbot at module scope, so we must set it before import
;(window as any).slashbot = {
  ...(window as any).slashbot,
  beads: {
    ...((window as any).slashbot?.beads ?? {}),
    comments: mockComments,
    addComment: mockAddComment,
  },
}

import CommentThread from './CommentThread'

let domContainer: HTMLDivElement | null = null

beforeEach(() => {
  mockComments.mockClear().mockResolvedValue([])
  mockAddComment.mockClear().mockResolvedValue({ ok: true })
  domContainer = document.createElement('div')
  document.body.appendChild(domContainer)
})

afterEach(() => {
  if (domContainer) {
    document.body.removeChild(domContainer)
    domContainer = null
  }
})

describe('CommentThread', () => {
  test('renders loading state initially via SSR', () => {
    const html = renderToStaticMarkup(
      <CommentThread beadId="sb-abc.1" projectPath="/tmp/test" />
    )
    expect(html).toContain('Loading comments')
    expect(html).toContain('comment-thread')
  })

  test('renders empty state when no comments exist', async () => {
    mockComments.mockResolvedValue([])

    await act(async () => {
      const root = createRoot(domContainer!)
      root.render(<CommentThread beadId="sb-abc.1" projectPath="/tmp/test" />)
    })

    const html = domContainer!.innerHTML
    expect(html).toContain('No comments yet')
    expect(html).toContain('Comments (0)')
  })

  test('renders comment list with author, time, and text', async () => {
    const comments = [
      { id: 'c1', issueId: 'sb-abc.1', author: 'alice', text: 'Looks good', createdAt: '2026-04-10T12:00:00Z' },
      { id: 'c2', issueId: 'sb-abc.1', author: 'bob', text: 'Needs work', createdAt: '2026-04-10T13:00:00Z' },
    ]
    mockComments.mockImplementation(() => Promise.resolve(comments))

    let root: ReturnType<typeof createRoot>
    await act(async () => {
      root = createRoot(domContainer!)
      root.render(<CommentThread beadId="sb-abc.1" projectPath="/tmp/test" />)
    })

    // Wait for the async refresh to complete
    await act(async () => {
      await new Promise(r => setTimeout(r, 0))
    })

    const html = domContainer!.innerHTML
    expect(html).toContain('Comments (2)')
    expect(html).toContain('alice')
    expect(html).toContain('bob')
    expect(html).toContain('Looks good')
    expect(html).toContain('Needs work')
  })

  test('calls comments API with correct args', async () => {
    mockComments.mockImplementation(() => Promise.resolve([]))

    await act(async () => {
      const root = createRoot(domContainer!)
      root.render(<CommentThread beadId="sb-xyz.3" projectPath="/tmp/proj" />)
    })

    await act(async () => {
      await new Promise(r => setTimeout(r, 0))
    })

    expect(mockComments).toHaveBeenCalledWith('/tmp/proj', 'sb-xyz.3')
  })

  test('renders add-comment textarea and button', async () => {
    mockComments.mockResolvedValue([])

    await act(async () => {
      const root = createRoot(domContainer!)
      root.render(<CommentThread beadId="sb-abc.1" projectPath="/tmp/test" />)
    })

    const textarea = domContainer!.querySelector('.comment-textarea') as HTMLTextAreaElement
    expect(textarea).not.toBeNull()
    expect(textarea.placeholder).toBe('Add a comment...')

    const btn = domContainer!.querySelector('.comment-input-area .btn') as HTMLButtonElement
    expect(btn).not.toBeNull()
    expect(btn.textContent).toContain('Comment')
    // Button should be disabled when textarea is empty
    expect(btn.disabled).toBe(true)
  })

  test('submit button enables when text is entered', async () => {
    mockComments.mockResolvedValue([])

    await act(async () => {
      const root = createRoot(domContainer!)
      root.render(<CommentThread beadId="sb-abc.1" projectPath="/tmp/test" />)
    })

    const textarea = domContainer!.querySelector('.comment-textarea') as HTMLTextAreaElement
    const btn = domContainer!.querySelector('.comment-input-area .btn') as HTMLButtonElement

    // Type into the textarea — use native setter + input event (React 18 listens to input)
    await act(async () => {
      const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
        window.HTMLTextAreaElement.prototype, 'value'
      )!.set!
      nativeInputValueSetter.call(textarea, 'Test comment')
      textarea.dispatchEvent(new Event('input', { bubbles: true }))
    })

    // Button should now be enabled since text is non-empty
    expect(btn.disabled).toBe(false)
  })

  test('posting a comment calls addComment and refreshes the list', async () => {
    mockComments
      .mockResolvedValueOnce([])  // initial load
      .mockResolvedValueOnce([    // after posting
        { id: 'c1', issueId: 'sb-abc.1', author: 'me', text: 'Hello world', createdAt: '2026-04-10T14:00:00Z' },
      ])

    let root: ReturnType<typeof createRoot>
    await act(async () => {
      root = createRoot(domContainer!)
      root.render(<CommentThread beadId="sb-abc.1" projectPath="/tmp/test" />)
    })
    await act(async () => { await new Promise(r => setTimeout(r, 0)) })

    // Should start with no comments
    expect(domContainer!.innerHTML).toContain('No comments yet')

    // Type into the textarea
    const textarea = domContainer!.querySelector('.comment-textarea') as HTMLTextAreaElement
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!
      setter.call(textarea, 'Hello world')
      textarea.dispatchEvent(new Event('input', { bubbles: true }))
    })

    // Click the Comment button
    const btn = domContainer!.querySelector('.comment-input-area .btn') as HTMLButtonElement
    await act(async () => { btn.click() })
    await act(async () => { await new Promise(r => setTimeout(r, 0)) })

    expect(mockAddComment).toHaveBeenCalledWith('/tmp/test', 'sb-abc.1', 'Hello world')
    expect(domContainer!.innerHTML).toContain('Comments (1)')
    expect(domContainer!.innerHTML).toContain('Hello world')
    expect(domContainer!.innerHTML).not.toContain('No comments yet')
  })

  test('handles API error gracefully', async () => {
    mockComments.mockRejectedValue(new Error('Network error'))

    await act(async () => {
      const root = createRoot(domContainer!)
      root.render(<CommentThread beadId="sb-abc.1" projectPath="/tmp/test" />)
    })

    const html = domContainer!.innerHTML
    // Should show empty state on error, not crash
    expect(html).toContain('No comments yet')
    expect(html).toContain('Comments (0)')
  })

  test('handles non-array API response gracefully', async () => {
    mockComments.mockResolvedValue(null)

    await act(async () => {
      const root = createRoot(domContainer!)
      root.render(<CommentThread beadId="sb-abc.1" projectPath="/tmp/test" />)
    })

    const html = domContainer!.innerHTML
    expect(html).toContain('No comments yet')
  })
})
