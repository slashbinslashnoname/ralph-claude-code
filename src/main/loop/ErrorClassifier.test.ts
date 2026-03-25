import { describe, it, expect } from 'vitest'
import { classifyError } from './ErrorClassifier'

describe('ErrorClassifier', () => {
  describe('permanent errors', () => {
    it('classifies "invalid api key"', () => {
      expect(classifyError('Error: invalid api key provided')).toBe('permanent')
    })

    it('classifies "authentication failed"', () => {
      expect(classifyError('authentication failed for user xyz')).toBe('permanent')
    })

    it('classifies "unauthorized"', () => {
      expect(classifyError('401 Unauthorized')).toBe('permanent')
    })

    it('classifies "account disabled"', () => {
      expect(classifyError('Your account disabled by admin')).toBe('permanent')
    })

    it('classifies "model not found"', () => {
      expect(classifyError('model not found: claude-99')).toBe('permanent')
    })
  })

  describe('transient errors', () => {
    it('classifies ECONNRESET', () => {
      expect(classifyError('Error: read ECONNRESET')).toBe('transient')
    })

    it('classifies ETIMEDOUT', () => {
      expect(classifyError('connect ETIMEDOUT 104.18.6.192:443')).toBe('transient')
    })

    it('classifies ENOTFOUND', () => {
      expect(classifyError('getaddrinfo ENOTFOUND api.example.com')).toBe('transient')
    })

    it('classifies ECONNREFUSED', () => {
      expect(classifyError('connect ECONNREFUSED 127.0.0.1:3000')).toBe('transient')
    })

    it('classifies "socket hang up"', () => {
      expect(classifyError('Error: socket hang up')).toBe('transient')
    })

    it('classifies "network error"', () => {
      expect(classifyError('Network Error: unable to reach host')).toBe('transient')
    })

    it('classifies "fetch failed"', () => {
      expect(classifyError('TypeError: fetch failed')).toBe('transient')
    })
  })

  describe('unknown errors', () => {
    it('returns unknown for unrecognized errors', () => {
      expect(classifyError('Something went wrong')).toBe('unknown')
    })

    it('returns unknown for empty string', () => {
      expect(classifyError('')).toBe('unknown')
    })
  })

  describe('case insensitivity', () => {
    it('matches permanent patterns case-insensitively', () => {
      expect(classifyError('INVALID API KEY')).toBe('permanent')
      expect(classifyError('Invalid Api Key')).toBe('permanent')
      expect(classifyError('AUTHENTICATION FAILED')).toBe('permanent')
    })

    it('matches transient patterns case-insensitively for socket/network/fetch', () => {
      expect(classifyError('Socket Hang Up')).toBe('transient')
      expect(classifyError('NETWORK ERROR')).toBe('transient')
      expect(classifyError('Fetch Failed')).toBe('transient')
    })
  })

  describe('precedence', () => {
    it('permanent takes precedence over transient', () => {
      expect(classifyError('invalid api key due to network error')).toBe('permanent')
      expect(classifyError('ECONNRESET unauthorized access')).toBe('permanent')
    })
  })

  describe('substring matching', () => {
    it('matches patterns embedded in longer messages', () => {
      expect(
        classifyError(
          '[2026-03-25T10:00:00Z] ERROR: API call failed with invalid api key - check your credentials'
        )
      ).toBe('permanent')
      expect(
        classifyError(
          'RequestError: connect ETIMEDOUT 104.18.6.192:443 after 30000ms'
        )
      ).toBe('transient')
    })
  })
})
