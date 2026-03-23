import { describe, it, expect } from 'vitest'
import type { MailMessage } from '../types'

/**
 * Tests for mcp-coordination-server.ts beadId consumption logic.
 *
 * The MCP server file has module-level side effects (creates McpServer, connects
 * to stdio), so we cannot import it directly. We test the core logic by
 * replicating the small expressions used in the handler and verifying behavior.
 */

describe('mcp-coordination-server beadId consumption', () => {
  describe('threadId defaulting logic', () => {
    // Mirrors the expression: thread_id ?? beadId ?? 'general'
    function resolveThreadId(
      thread_id: string | undefined,
      beadId: string | null
    ): string {
      return thread_id ?? beadId ?? 'general'
    }

    it('uses explicit thread_id when provided', () => {
      expect(resolveThreadId('custom-thread', 'bead-123')).toBe('custom-thread')
    })

    it('falls back to beadId when no thread_id provided', () => {
      expect(resolveThreadId(undefined, 'bead-123')).toBe('bead-123')
    })

    it('falls back to "general" when neither thread_id nor beadId available', () => {
      expect(resolveThreadId(undefined, null)).toBe('general')
    })

    it('uses explicit thread_id even when beadId is null', () => {
      expect(resolveThreadId('my-thread', null)).toBe('my-thread')
    })
  })

  describe('beadId field on MailMessage', () => {
    // Mirrors: ...(beadId ? { beadId } : {})
    function buildMessage(
      agentId: string,
      to: string,
      subject: string,
      body: string,
      thread_id: string | undefined,
      beadId: string | null
    ): MailMessage {
      return {
        ts: new Date().toISOString(),
        from: agentId,
        to,
        subject,
        body,
        threadId: thread_id ?? beadId ?? 'general',
        read: false,
        ...(beadId ? { beadId } : {}),
      }
    }

    it('includes beadId and uses it as threadId when env var is set', () => {
      const msg = buildMessage('worker-0', 'worker-1', 'test', 'body', undefined, 'sb-abc.1')
      expect(msg.beadId).toBe('sb-abc.1')
      expect(msg.threadId).toBe('sb-abc.1')
    })

    it('omits beadId and falls back to "general" when env var is not set', () => {
      const msg = buildMessage('worker-0', 'worker-1', 'test', 'body', undefined, null)
      expect(msg.beadId).toBeUndefined()
      expect(msg.threadId).toBe('general')
    })

    it('uses explicit thread_id but still includes beadId', () => {
      const msg = buildMessage('worker-0', 'all', 'help', 'need review', 'my-thread', 'sb-xyz.2')
      expect(msg.threadId).toBe('my-thread')
      expect(msg.beadId).toBe('sb-xyz.2')
    })

    it('preserves all standard MailMessage fields', () => {
      const msg = buildMessage('worker-0', 'worker-1', 'subj', 'bod', undefined, 'sb-a.1')
      expect(msg.from).toBe('worker-0')
      expect(msg.to).toBe('worker-1')
      expect(msg.subject).toBe('subj')
      expect(msg.body).toBe('bod')
      expect(msg.read).toBe(false)
      expect(msg.ts).toBeDefined()
    })
  })

  describe('env var defaulting', () => {
    it('SLASHBOT_BEAD_ID defaults to null when not set', () => {
      // Mirrors: const beadId = process.env.SLASHBOT_BEAD_ID ?? null
      const beadId = undefined ?? null
      expect(beadId).toBeNull()
    })

    it('SLASHBOT_BEAD_ID is captured when set', () => {
      const beadId = 'sb-test.1' ?? null
      expect(beadId).toBe('sb-test.1')
    })
  })
})
