import { describe, test, expect, vi, beforeEach } from 'vitest'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

const mocks = vi.hoisted(() => {
  const mockList = vi.fn().mockResolvedValue([])
  const mockSubscribe = vi.fn().mockResolvedValue(undefined)
  const mockUnsubscribe = vi.fn().mockResolvedValue(undefined)
  const mockOnMessage = vi.fn().mockReturnValue(() => {})

  ;(globalThis as any).window = {
    slashbot: {
      mail: {
        list: mockList,
        subscribe: mockSubscribe,
        unsubscribe: mockUnsubscribe,
        onMessage: mockOnMessage,
      },
    },
  }

  return { mockList, mockSubscribe, mockUnsubscribe, mockOnMessage }
})

import MailPage from './MailPage'

beforeEach(() => {
  vi.clearAllMocks()
  mocks.mockList.mockResolvedValue([])
  mocks.mockOnMessage.mockReturnValue(() => {})
})

// ---------------------------------------------------------------------------
// Current stub tests
// ---------------------------------------------------------------------------
describe('MailPage (stub)', () => {
  test('renders with project path', () => {
    const html = renderToStaticMarkup(<MailPage projectPath="/test/project" />)
    expect(html).toContain('Mail')
    expect(html).toContain('project')
  })

  test('renders page container', () => {
    const html = renderToStaticMarkup(<MailPage projectPath="/foo/bar" />)
    expect(html).toContain('page-container')
    expect(html).toContain('bar')
  })

  test('extracts folder name from project path', () => {
    const html = renderToStaticMarkup(<MailPage projectPath="/home/user/my-app" />)
    expect(html).toContain('my-app')
  })

  test('renders without crashing for various paths', () => {
    expect(() => renderToStaticMarkup(<MailPage projectPath="" />)).not.toThrow()
    expect(() => renderToStaticMarkup(<MailPage projectPath="/" />)).not.toThrow()
    expect(() =>
      renderToStaticMarkup(<MailPage projectPath="/a/b/c/d/e" />),
    ).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// Forward-looking tests for full MailPage implementation (sb-r1q.5)
// These tests document the expected behavior once the component is fully
// implemented. They use test.todo so they don't fail against the current stub.
// ---------------------------------------------------------------------------
describe('MailPage (full implementation — pending sb-r1q.5)', () => {
  test.todo('renders empty state when mail.list returns []')

  test.todo('renders message list when mail.list returns messages')

  test.todo('calls mail.list with projectPath on mount')

  test.todo('calls mail.subscribe with projectPath on mount')

  test.todo('calls mail.unsubscribe on unmount')

  test.todo('calls mail.onMessage on mount and stores cleanup')

  test.todo('selecting a message/thread shows its body in detail pane')

  test.todo('unread filter narrows list to unread messages only')

  test.todo('agent filter narrows list to messages from/to selected agent')

  test.todo('live message from onMessage callback is prepended to list')

  test.todo('live message for different projectPath is ignored')

  test.todo('onMessage cleanup function is called on unmount')
})
