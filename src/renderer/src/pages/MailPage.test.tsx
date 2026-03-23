import { describe, test, expect, vi } from 'vitest'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

vi.hoisted(() => {
  ;(globalThis as any).window = { slashbot: {} }
})

import MailPage from './MailPage'

describe('MailPage', () => {
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
})
