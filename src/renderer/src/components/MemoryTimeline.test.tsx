import { describe, test, expect } from 'vitest'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import MemoryTimeline from './MemoryTimeline'

describe('MemoryTimeline', () => {
  test('renders nothing when memory has no createdAt', () => {
    const html = renderToStaticMarkup(
      <MemoryTimeline memory={{ key: 'test', text: 'hello' }} />,
    )
    expect(html).toBe('')
  })

  test('renders timeline with creation event when createdAt is present', () => {
    const html = renderToStaticMarkup(
      <MemoryTimeline
        memory={{ key: 'test', text: 'hello', createdAt: '2026-04-10T14:30:00Z' }}
      />,
    )
    expect(html).toContain('unified-timeline')
    expect(html).toContain('memory-timeline')
    expect(html).toContain('created')
    expect(html).toContain('badge-info')
  })

  test('uses formatTime for consistent date display', () => {
    const html = renderToStaticMarkup(
      <MemoryTimeline
        memory={{ key: 'test', text: 'hello', createdAt: '2026-04-10T14:30:00Z' }}
      />,
    )
    // formatTime produces locale-specific output, but should contain the month
    expect(html).toContain('Apr')
  })

  test('renders lifecycle icon for creation', () => {
    const html = renderToStaticMarkup(
      <MemoryTimeline
        memory={{ key: 'test', text: 'hello', createdAt: '2026-04-10T14:30:00Z' }}
      />,
    )
    // ⊕ character (U+2295)
    expect(html).toContain('\u2295')
  })

  test('reuses unified-timeline CSS classes for visual consistency', () => {
    const html = renderToStaticMarkup(
      <MemoryTimeline
        memory={{ key: 'test', text: 'hello', createdAt: '2026-04-10T14:30:00Z' }}
      />,
    )
    expect(html).toContain('unified-timeline-event')
    expect(html).toContain('unified-timeline-lifecycle')
    expect(html).toContain('unified-timeline-icon')
    expect(html).toContain('unified-timeline-time')
    expect(html).toContain('unified-timeline-content')
    expect(html).toContain('unified-timeline-entry-header')
  })
})
