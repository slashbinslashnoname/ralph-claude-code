import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
vi.mock('fs', async (importOriginal) => ({ ...(await importOriginal<typeof import('fs')>()) }))
vi.mock('child_process', async (importOriginal) => ({ ...(await importOriginal<typeof import('child_process')>()) }))
import * as cp from 'child_process'
import type { exec as execType } from 'child_process'
import { BdClient } from './BdClient'

let mockExecSync: any
let mockExec: any

beforeEach(() => {
  mockExecSync = vi.spyOn(cp, 'execSync').mockReturnValue('[]')
  mockExec = vi.spyOn(cp, 'exec').mockReturnValue(undefined as any)
})

afterEach(() => {
  vi.restoreAllMocks()
})

// ── Helper: build a raw bd JSON bead ──────────────────────────────────────

function rawBead(overrides: Record<string, unknown> = {}) {
  return {
    id: 'abc-123',
    title: 'Test bead',
    status: 'open',
    issue_type: 'task',
    priority: 2,
    description: 'A test bead',
    labels: [],
    deps: [],
    files: [],
    assignee: null,
    parent_id: null,
    ...overrides,
  }
}

describe('BdClient', () => {
  let client: BdClient

  beforeEach(() => {
    client = new BdClient('/fake/project')
  })

  // ── list ───────────────────────────────────────────────────────────────

  describe('list', () => {
    it('returns normalized beads from bd list', () => {
      mockExecSync.mockReturnValue(JSON.stringify([
        rawBead({ id: 'b1', status: 'open' }),
        rawBead({ id: 'b2', status: 'in_progress', assignee: 'agent-0' }),
        rawBead({ id: 'b3', status: 'closed', closed_at: '2026-01-01' }),
      ]))

      const result = client.list()

      expect(result).toHaveLength(3)
      expect(result[0]).toMatchObject({ id: 'b1', status: 'ready' })
      expect(result[1]).toMatchObject({ id: 'b2', status: 'claimed', claimedBy: 'agent-0' })
      expect(result[2]).toMatchObject({ id: 'b3', status: 'done', completedAt: '2026-01-01' })
    })

    it('passes filter arguments to bd CLI', () => {
      mockExecSync.mockReturnValue('[]')
      client.list({ status: 'open', type: 'task', priority: 1, label: 'urgent', assignee: 'agent-1' })

      const call = mockExecSync.mock.calls[0][0] as string
      expect(call).toContain('list')
      expect(call).toContain('--status open')
      expect(call).toContain('--type task')
      expect(call).toContain('--priority 1')
      expect(call).toContain('--label urgent')
      expect(call).toContain('--assignee agent-1')
      expect(call).toContain('--json')
    })

    it('returns empty array for non-array response', () => {
      mockExecSync.mockReturnValue(JSON.stringify({ not: 'an array' }))
      expect(client.list()).toEqual([])
    })
  })

  // ── create ─────────────────────────────────────────────────────────────

  describe('create', () => {
    it('creates a bead with minimal options', () => {
      mockExecSync.mockReturnValue(JSON.stringify(rawBead({ id: 'new-1' })))

      const result = client.create({ title: 'New bead' })

      expect(result.id).toBe('new-1')
      const call = mockExecSync.mock.calls[0][0] as string
      expect(call).toContain('create "New bead"')
      expect(call).toContain('--json')
    })

    it('passes all optional arguments', () => {
      mockExecSync.mockReturnValue(JSON.stringify(rawBead()))

      client.create({
        title: 'Full bead',
        type: 'epic',
        priority: 1,
        description: 'A description',
        labels: ['alpha', 'beta'],
        parentId: 'parent-1',
        id: 'custom-id',
      })

      const call = mockExecSync.mock.calls[0][0] as string
      expect(call).toContain('-t epic')
      expect(call).toContain('-p 1')
      expect(call).toContain('-d "A description"')
      expect(call).toContain('-l alpha,beta')
      expect(call).toContain('--parent parent-1')
      expect(call).toContain('--id custom-id')
    })
  })

  // ── createAsync ────────────────────────────────────────────────────────

  describe('createAsync', () => {
    it('creates a bead asynchronously', async () => {
      mockExec.mockImplementation((_cmd: any, _opts: any, cb: any) => {
        ;(cb as Function)(null, JSON.stringify(rawBead({ id: 'async-1' })), '')
        return {} as ReturnType<typeof execType>
      })

      const result = await client.createAsync({ title: 'Async bead' })
      expect(result.id).toBe('async-1')
    })

    it('rejects on exec error', async () => {
      mockExec.mockImplementation((_cmd: any, _opts: any, cb: any) => {
        ;(cb as Function)(new Error('spawn failed'), '', 'bd not found')
        return {} as ReturnType<typeof execType>
      })

      await expect(client.createAsync({ title: 'Fail' }))
        .rejects.toThrow('bd create failed')
    })
  })

  // ── createMany ─────────────────────────────────────────────────────────

  describe('createMany', () => {
    it('creates multiple beads and returns results', async () => {
      let callCount = 0
      mockExec.mockImplementation((_cmd: any, _opts: any, cb: any) => {
        callCount++
        ;(cb as Function)(null, JSON.stringify(rawBead({ id: `many-${callCount}` })), '')
        return {} as ReturnType<typeof execType>
      })

      const result = await client.createMany([
        { title: 'First' },
        { title: 'Second' },
      ])

      expect(result).toHaveLength(2)
      expect(result[0].id).toBe('many-1')
      expect(result[1].id).toBe('many-2')
    })

    it('continues after individual failures', async () => {
      let callCount = 0
      mockExec.mockImplementation((_cmd: any, _opts: any, cb: any) => {
        callCount++
        if (callCount === 1) {
          ;(cb as Function)(new Error('fail'), '', 'error')
        } else {
          ;(cb as Function)(null, JSON.stringify(rawBead({ id: 'survived' })), '')
        }
        return {} as ReturnType<typeof execType>
      })

      const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
      const result = await client.createMany([
        { title: 'Will fail' },
        { title: 'Will succeed' },
      ])

      expect(result).toHaveLength(1)
      expect(result[0].id).toBe('survived')
      spy.mockRestore()
    })
  })

  // ── show ───────────────────────────────────────────────────────────────

  describe('show', () => {
    it('returns normalized bead', () => {
      mockExecSync.mockReturnValue(JSON.stringify(rawBead({ id: 'show-1' })))
      const result = client.show('show-1')
      expect(result).not.toBeNull()
      expect(result!.id).toBe('show-1')

      const call = mockExecSync.mock.calls[0][0] as string
      expect(call).toContain('show show-1')
    })

    it('returns null on error', () => {
      mockExecSync.mockImplementation(() => { throw new Error('not found') })
      expect(client.show('missing')).toBeNull()
    })
  })

  // ── ready ──────────────────────────────────────────────────────────────

  describe('ready', () => {
    it('returns ready beads', () => {
      mockExecSync.mockReturnValue(JSON.stringify([
        rawBead({ id: 'r1', status: 'open' }),
      ]))

      const result = client.ready()
      expect(result).toHaveLength(1)
      expect(result[0].id).toBe('r1')
      expect(result[0].status).toBe('ready')
    })

    it('returns empty array on error', () => {
      mockExecSync.mockImplementation(() => { throw new Error('fail') })
      expect(client.ready()).toEqual([])
    })
  })

  // ── update ─────────────────────────────────────────────────────────────

  describe('update', () => {
    it('updates title', () => {
      mockExecSync.mockReturnValue('{}')
      client.update('u1', { title: 'New title' })

      const call = mockExecSync.mock.calls[0][0] as string
      expect(call).toContain('update u1 --title "New title" --json')
    })

    it('updates priority', () => {
      mockExecSync.mockReturnValue('{}')
      client.update('u1', { priority: 3 })

      const call = mockExecSync.mock.calls[0][0] as string
      expect(call).toContain('update u1 --priority 3 --json')
    })

    it('claims a bead', () => {
      mockExecSync.mockReturnValue('{}')
      client.update('u1', { claim: true })

      const call = mockExecSync.mock.calls[0][0] as string
      expect(call).toContain('update u1 --claim --json')
    })

    it('unclaims a bead', () => {
      mockExecSync.mockReturnValue('{}')
      client.update('u1', { unclaim: true })

      const call = mockExecSync.mock.calls[0][0] as string
      expect(call).toContain('update u1 --assignee "" --json')
    })

    it('adds and removes labels', () => {
      mockExecSync.mockReturnValue('{}')
      client.update('u1', { labels: { add: ['bug'], remove: ['wip'] } })

      const calls = mockExecSync.mock.calls.map((c: any) => c[0] as string)
      expect(calls.some((c: string) => c.includes('label add u1 bug --json'))).toBe(true)
      expect(calls.some((c: string) => c.includes('label remove u1 wip --json'))).toBe(true)
    })
  })

  // ── claim ──────────────────────────────────────────────────────────────

  describe('claim', () => {
    it('returns true on success', () => {
      mockExecSync.mockReturnValue('{}')
      expect(client.claim('c1')).toBe(true)
    })

    it('returns false on failure', () => {
      mockExecSync.mockImplementation(() => { throw new Error('already claimed') })
      expect(client.claim('c1')).toBe(false)
    })
  })

  // ── assignTo ───────────────────────────────────────────────────────────

  describe('assignTo', () => {
    it('unclaims then assigns', () => {
      mockExecSync.mockReturnValue('{}')
      expect(client.assignTo('a1', 'agent-5')).toBe(true)

      const calls = mockExecSync.mock.calls.map((c: any) => c[0] as string)
      expect(calls[0]).toContain('--claim')
      expect(calls[0]).toContain('-a agent-5')
    })

    it('returns false if assign fails', () => {
      mockExecSync.mockImplementation(() => {
        throw new Error('fail')
      })
      expect(client.assignTo('a1', 'agent-5')).toBe(false)
    })
  })

  // ── close / reopen ────────────────────────────────────────────────────

  describe('close', () => {
    it('closes with default reason', () => {
      mockExecSync.mockReturnValue('{}')
      client.close('cl1')

      const call = mockExecSync.mock.calls[0][0] as string
      expect(call).toContain('close cl1 --reason "Done" --json')
    })

    it('closes with custom reason', () => {
      mockExecSync.mockReturnValue('{}')
      client.close('cl1', 'Completed successfully')

      const call = mockExecSync.mock.calls[0][0] as string
      expect(call).toContain('--reason "Completed successfully"')
    })
  })

  describe('reopen', () => {
    it('reopens and clears claim and failed label', () => {
      mockExecSync.mockReturnValue('{}')
      client.reopen('ro1', 'Retry')

      const calls = mockExecSync.mock.calls.map((c: any) => c[0] as string)
      expect(calls[0]).toContain('reopen ro1 --reason "Retry" --json')
      expect(calls[1]).toContain('--assignee ""')
      expect(calls[2]).toContain('label remove ro1 failed')
    })

    it('reopens without reason', () => {
      mockExecSync.mockReturnValue('{}')
      client.reopen('ro1')

      const call = mockExecSync.mock.calls[0][0] as string
      expect(call).toContain('reopen ro1 --json')
      expect(call).not.toContain('--reason')
    })
  })

  // ── labels ─────────────────────────────────────────────────────────────

  describe('labels', () => {
    it('addLabel calls correct CLI args', () => {
      mockExecSync.mockReturnValue('{}')
      client.addLabel('l1', 'urgent')

      const call = mockExecSync.mock.calls[0][0] as string
      expect(call).toContain('label add l1 urgent --json')
    })

    it('removeLabel calls correct CLI args', () => {
      mockExecSync.mockReturnValue('{}')
      client.removeLabel('l1', 'wip')

      const call = mockExecSync.mock.calls[0][0] as string
      expect(call).toContain('label remove l1 wip --json')
    })

    it('listLabels returns labels array', () => {
      mockExecSync.mockReturnValue(JSON.stringify(['bug', 'feature', 'urgent']))
      expect(client.listLabels()).toEqual(['bug', 'feature', 'urgent'])
    })

    it('listLabels returns empty array on error', () => {
      mockExecSync.mockImplementation(() => { throw new Error('fail') })
      expect(client.listLabels()).toEqual([])
    })
  })

  // ── dependencies ───────────────────────────────────────────────────────

  describe('dependencies', () => {
    it('addDep calls bd dep add with type', () => {
      mockExecSync.mockReturnValue('')
      client.addDep('child-1', 'parent-1', 'blocks')

      const call = mockExecSync.mock.calls[0][0] as string
      expect(call).toContain('dep add child-1 parent-1 --type blocks')
    })

    it('addDep uses default type', () => {
      mockExecSync.mockReturnValue('')
      client.addDep('child-1', 'parent-1')

      const call = mockExecSync.mock.calls[0][0] as string
      expect(call).toContain('--type discovered-from')
    })

    it('depTree returns tree string', () => {
      mockExecSync.mockReturnValue('root\n  child-1\n  child-2')
      expect(client.depTree('root')).toBe('root\n  child-1\n  child-2')
    })
  })

  // ── state management ──────────────────────────────────────────────────

  describe('state management', () => {
    it('getState returns dimension value', () => {
      mockExecSync.mockReturnValue('blocked')
      expect(client.getState('s1', 'workflow')).toBe('blocked')
    })

    it('getState returns empty string on error', () => {
      mockExecSync.mockImplementation(() => { throw new Error('fail') })
      expect(client.getState('s1', 'workflow')).toBe('')
    })

    it('setState calls bd set-state', () => {
      mockExecSync.mockReturnValue('{}')
      client.setState('s1', 'workflow', 'active', 'Starting work')

      const call = mockExecSync.mock.calls[0][0] as string
      expect(call).toContain('set-state s1 workflow=active')
      expect(call).toContain('--reason "Starting work"')
      expect(call).toContain('--json')
    })

    it('setState without reason', () => {
      mockExecSync.mockReturnValue('{}')
      client.setState('s1', 'workflow', 'done')

      const call = mockExecSync.mock.calls[0][0] as string
      expect(call).toContain('set-state s1 workflow=done')
      expect(call).not.toContain('--reason')
    })
  })

  // ── stats ──────────────────────────────────────────────────────────────

  describe('stats', () => {
    it('computes stats from list', () => {
      mockExecSync.mockReturnValue(JSON.stringify([
        rawBead({ id: '1', status: 'open' }),
        rawBead({ id: '2', status: 'open' }),
        rawBead({ id: '3', status: 'in_progress' }),
        rawBead({ id: '4', status: 'closed' }),
        rawBead({ id: '5', status: 'open', labels: ['failed'] }),
      ]))

      const stats = client.stats()
      expect(stats.total).toBe(5)
      expect(stats.ready).toBe(2)
      expect(stats.claimed).toBe(1)
      expect(stats.done).toBe(1)
      expect(stats.failed).toBe(1)
      expect(stats.pct).toBe(20) // 1/5 = 20%
    })

    it('returns zero pct when no beads', () => {
      mockExecSync.mockReturnValue('[]')
      expect(client.stats().pct).toBe(0)
    })
  })

  // ── hasOpenWork ────────────────────────────────────────────────────────

  describe('hasOpenWork', () => {
    it('returns true when open beads exist', () => {
      mockExecSync.mockReturnValue(JSON.stringify([rawBead()]))
      expect(client.hasOpenWork()).toBe(true)
    })

    it('returns false when no open beads', () => {
      mockExecSync.mockReturnValue('[]')
      expect(client.hasOpenWork()).toBe(false)
    })
  })

  // ── check ──────────────────────────────────────────────────────────────

  describe('check', () => {
    it('returns available when bd is found and .beads exists', () => {
      mockExecSync.mockReturnValue('/usr/local/bin/bd')

      const fs = require('fs')
      const spy = vi.spyOn(fs, 'existsSync').mockReturnValue(true)

      const result = client.check()
      expect(result).toEqual({ available: true })

      spy.mockRestore()
    })

    it('returns unavailable when bd not found', () => {
      mockExecSync.mockImplementation(() => { throw new Error('not found') })

      const result = client.check()
      expect(result.available).toBe(false)
      expect(result.reason).toContain('not found on PATH')
    })

    it('uses enriched env for which command', () => {
      mockExecSync.mockReturnValue('/usr/local/bin/bd')

      const fs = require('fs')
      const spy = vi.spyOn(fs, 'existsSync').mockReturnValue(true)

      client.check()

      // The 'which bd' call should pass env with enriched PATH
      const whichCall = mockExecSync.mock.calls[0]
      const opts = whichCall[1] as Record<string, unknown>
      const env = opts.env as NodeJS.ProcessEnv
      expect(env.PATH).toContain('.local/share/mise/shims')

      spy.mockRestore()
    })

    it('returns unavailable when .beads dir missing', () => {
      mockExecSync.mockReturnValue('/usr/local/bin/bd')

      const fs = require('fs')
      const spy = vi.spyOn(fs, 'existsSync').mockReturnValue(false)

      const result = client.check()
      expect(result.available).toBe(false)
      expect(result.reason).toContain('No .beads directory')

      spy.mockRestore()
    })
  })

  // ── info ───────────────────────────────────────────────────────────────

  describe('info', () => {
    it('returns parsed JSON from bd info', () => {
      const infoData = { version: '1.2.3', project: 'test' }
      mockExecSync.mockReturnValue(JSON.stringify(infoData))

      expect(client.info()).toEqual(infoData)
    })
  })

  // ── normalizeBead (tested indirectly) ─────────────────────────────────

  describe('normalizeBead (via list/show)', () => {
    it('maps open status to ready', () => {
      mockExecSync.mockReturnValue(JSON.stringify([rawBead({ status: 'open' })]))
      expect(client.list()[0].status).toBe('ready')
    })

    it('maps in_progress status to claimed', () => {
      mockExecSync.mockReturnValue(JSON.stringify([rawBead({ status: 'in_progress' })]))
      expect(client.list()[0].status).toBe('claimed')
    })

    it('maps closed status to done', () => {
      mockExecSync.mockReturnValue(JSON.stringify([rawBead({ status: 'closed' })]))
      expect(client.list()[0].status).toBe('done')
    })

    it('maps unknown status to pending', () => {
      mockExecSync.mockReturnValue(JSON.stringify([rawBead({ status: 'weird' })]))
      expect(client.list()[0].status).toBe('pending')
    })

    it('overrides status to failed when label present', () => {
      mockExecSync.mockReturnValue(JSON.stringify([rawBead({ status: 'open', labels: ['failed'] })]))
      expect(client.list()[0].status).toBe('failed')
    })

    it('maps issue_type to bead type', () => {
      mockExecSync.mockReturnValue(JSON.stringify([rawBead({ issue_type: 'epic' })]))
      expect(client.list()[0].type).toBe('epic')

      mockExecSync.mockReturnValue(JSON.stringify([rawBead({ issue_type: 'subtask' })]))
      expect(client.list()[0].type).toBe('subtask')

      mockExecSync.mockReturnValue(JSON.stringify([rawBead({ issue_type: 'task' })]))
      expect(client.list()[0].type).toBe('task')
    })

    it('falls back to type field when issue_type missing', () => {
      mockExecSync.mockReturnValue(JSON.stringify([rawBead({ issue_type: undefined, type: 'epic' })]))
      expect(client.list()[0].type).toBe('epic')
    })

    it('handles array response (bd close returns array)', () => {
      mockExecSync.mockReturnValue(JSON.stringify([rawBead({ id: 'arr-1' })]))
      const result = client.show('arr-1')
      // show wraps single object, but if bd returns array the normalizer unwraps it
      expect(result).not.toBeNull()
    })

    it('maps body to description when description is missing', () => {
      mockExecSync.mockReturnValue(JSON.stringify([
        rawBead({ description: undefined, body: 'From body field' }),
      ]))
      expect(client.list()[0].description).toBe('From body field')
    })

    it('maps dependencies field as fallback for deps', () => {
      mockExecSync.mockReturnValue(JSON.stringify([
        rawBead({ deps: undefined, dependencies: [
          { depends_on_id: 'dep-1', type: 'discovered-from' },
          { depends_on_id: 'dep-2', type: 'discovered-from' },
        ] }),
      ]))
      const bead = client.list()[0]
      expect(bead.deps).toEqual(['dep-1', 'dep-2'])
    })

    it('defaults priority to 2 for non-numeric values', () => {
      mockExecSync.mockReturnValue(JSON.stringify([rawBead({ priority: 'high' })]))
      expect(client.list()[0].priority).toBe(2)
    })

    it('maps all optional fields', () => {
      mockExecSync.mockReturnValue(JSON.stringify([rawBead({
        assignee: 'agent-3',
        claimed_at: '2026-01-01',
        closed_at: '2026-01-02',
        parent_id: 'epic-1',
        task_id: 'task-99',
        files: ['a.ts', 'b.ts'],
      })]))

      const bead = client.list()[0]
      expect(bead.claimedBy).toBe('agent-3')
      expect(bead.claimedAt).toBe('2026-01-01')
      expect(bead.completedAt).toBe('2026-01-02')
      expect(bead.epicId).toBe('epic-1')
      expect(bead.taskId).toBe('task-99')
      expect(bead.files).toEqual(['a.ts', 'b.ts'])
    })
  })

  // ── error handling ─────────────────────────────────────────────────────

  describe('error handling', () => {
    it('wraps execSync errors with command context', () => {
      const err = new Error('command failed') as Error & { stderr: string }
      err.stderr = 'bd: permission denied'
      mockExecSync.mockImplementation(() => { throw err })

      expect(() => client.list()).toThrow('bd list failed: bd: permission denied')
    })

    it('falls back to error message when stderr missing', () => {
      mockExecSync.mockImplementation(() => { throw new Error('ENOENT') })
      expect(() => client.list()).toThrow('bd list failed: ENOENT')
    })

    it('handles non-Error throws', () => {
      mockExecSync.mockImplementation(() => { throw 'string error' })
      expect(() => client.list()).toThrow('bd list failed: string error')
    })

    it('throws on invalid JSON', () => {
      mockExecSync.mockReturnValue('not json at all')
      expect(() => client.list()).toThrow()
    })

    it('passes correct exec options with enriched PATH', () => {
      mockExecSync.mockReturnValue('[]')
      client.list()

      const opts = mockExecSync.mock.calls[0][1] as Record<string, unknown>
      expect(opts.cwd).toBe('/fake/project')
      expect(opts.timeout).toBe(15_000)
      expect(opts.encoding).toBe('utf8')
      // ENV should come from buildEnv() and include mise shims
      const env = opts.env as NodeJS.ProcessEnv
      expect(env.PATH).toContain('.local/share/mise/shims')
    })

    it('uses custom bd command name', () => {
      const custom = new BdClient('/fake', 'custom-bd')
      mockExecSync.mockReturnValue('[]')
      custom.list()

      const call = mockExecSync.mock.calls[0][0] as string
      expect(call.startsWith('custom-bd ')).toBe(true)
    })
  })
})
