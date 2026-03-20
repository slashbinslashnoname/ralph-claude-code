import { describe, it, expect } from 'vitest'
import { stripAnsi } from './utils'

describe('stripAnsi', () => {
  it('removes SGR escape sequences', () => {
    expect(stripAnsi('\x1B[31mred\x1B[0m')).toBe('red')
  })

  it('removes OSC sequences', () => {
    expect(stripAnsi('\x1B]0;title\x07text')).toBe('text')
  })

  it('removes charset selection sequences', () => {
    expect(stripAnsi('\x1B(Btext')).toBe('text')
  })

  it('removes keypad mode sequences', () => {
    expect(stripAnsi('\x1B=text\x1B>')).toBe('text')
  })

  it('normalizes line endings', () => {
    expect(stripAnsi('a\r\nb\rc')).toBe('a\nb\nc')
  })

  it('returns plain text unchanged', () => {
    expect(stripAnsi('hello world')).toBe('hello world')
  })

  it('handles empty string', () => {
    expect(stripAnsi('')).toBe('')
  })

  it('strips mixed escape sequences', () => {
    const input = '\x1B[1m\x1B[32m✓\x1B[0m Test passed\r\n'
    expect(stripAnsi(input)).toBe('✓ Test passed\n')
  })
})
