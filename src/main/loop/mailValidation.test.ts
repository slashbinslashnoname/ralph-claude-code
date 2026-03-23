import { describe, it, expect } from 'vitest'
import {
  validateMailList,
  validateMailSubscribe,
  validateMailUnsubscribe,
} from './mailValidation'

describe('validateMailList', () => {
  it('returns validated projectPath and default limit', () => {
    const result = validateMailList('/some/path', undefined)
    expect(result).toEqual({ projectPath: '/some/path', limit: 50 })
  })

  it('accepts explicit limit', () => {
    const result = validateMailList('/some/path', 100)
    expect(result).toEqual({ projectPath: '/some/path', limit: 100 })
  })

  it('throws on empty projectPath', () => {
    expect(() => validateMailList('', 10)).toThrow('projectPath')
  })

  it('throws on invalid limit', () => {
    expect(() => validateMailList('/p', -1)).toThrow('limit')
    expect(() => validateMailList('/p', 1001)).toThrow('limit')
    expect(() => validateMailList('/p', 'abc')).toThrow('limit')
  })
})

describe('validateMailSubscribe', () => {
  it('returns validated projectPath', () => {
    expect(validateMailSubscribe('/path')).toEqual({ projectPath: '/path' })
  })

  it('throws on empty projectPath', () => {
    expect(() => validateMailSubscribe('')).toThrow('projectPath')
  })

  it('throws on non-string projectPath', () => {
    expect(() => validateMailSubscribe(123)).toThrow('projectPath')
  })
})

describe('validateMailUnsubscribe', () => {
  it('returns validated projectPath', () => {
    expect(validateMailUnsubscribe('/path')).toEqual({ projectPath: '/path' })
  })

  it('throws on null projectPath', () => {
    expect(() => validateMailUnsubscribe(null)).toThrow('projectPath')
  })
})
