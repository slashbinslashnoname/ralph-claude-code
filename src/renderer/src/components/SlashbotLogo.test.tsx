import { describe, test, expect } from 'bun:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import SlashbotLogo from './SlashbotLogo'

describe('SlashbotLogo', () => {
  test('renders an SVG element', () => {
    const html = renderToStaticMarkup(<SlashbotLogo />)
    expect(html.startsWith('<svg')).toBe(true)
  })

  test('default size is 64', () => {
    const html = renderToStaticMarkup(<SlashbotLogo />)
    expect(html).toContain('width="64"')
    expect(html).toContain('height="64"')
  })

  test('respects custom size', () => {
    const html = renderToStaticMarkup(<SlashbotLogo size={24} />)
    expect(html).toContain('width="24"')
    expect(html).toContain('height="24"')
  })

  test('applies custom className', () => {
    const html = renderToStaticMarkup(<SlashbotLogo className="my-logo" />)
    expect(html).toContain('class="my-logo"')
  })

  test('contains hexagon path', () => {
    const html = renderToStaticMarkup(<SlashbotLogo />)
    expect(html).toContain('<path')
  })

  test('contains bot eye circles', () => {
    const html = renderToStaticMarkup(<SlashbotLogo />)
    const circleCount = (html.match(/<circle/g) || []).length
    expect(circleCount).toBeGreaterThanOrEqual(2)
  })

  test('contains the slash line', () => {
    const html = renderToStaticMarkup(<SlashbotLogo />)
    expect(html).toContain('<line')
  })

  test('has correct viewBox', () => {
    const html = renderToStaticMarkup(<SlashbotLogo />)
    expect(html).toContain('viewBox="0 0 100 100"')
  })
})
