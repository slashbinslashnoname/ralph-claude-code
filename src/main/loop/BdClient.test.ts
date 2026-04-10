import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
vi.mock('fs', async (importOriginal) => ({ ...(await importOriginal<typeof import('fs')>()) }))
vi.mock('child_process', async (importOriginal) => ({ ...(await importOriginal<typeof import('child_process')>()) }))
import * as cp from 'child_process'
import { BdClient } from './BdClient'

let mockExecFileSync: any
let mockExecFile: any

beforeEach(() => {
  mockExecFileSync = vi.spyOn(cp, 'execFileSync').mockReturnValue('[]')
  mockExecFile = vi.spyOn(cp, 'execFile').mockReturnValue(undefined as any)
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

/** Helper: extract args array from the first execFileSync call */
function syncArgs(callIndex = 0): string[] {
  return mockExecFileSync.mock.calls[callIndex][1] as string[]
}

/** Helper: extract args array from the first execFile call */
function asyncArgs(callIndex = 0): string[] {
  return mockExecFile.mock.calls[callIndex][1] as string[]
}

describe('BdClient', () => {
  let client: BdClient

  beforeEach(() => {
    client = new BdClient('/fake/project')
  })

  // ── list ───────────────────────────────────────────────────────────────

  describe('list', () => {
    it('returns normalized beads from bd list', () => {
      mockExecFileSync.mockReturnValue(JSON.stringify([
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

    it('passes filter arguments as array elements to bd CLI', () => {
      mockExecFileSync.mockReturnValue('[]')
      client.list({ status: 'open', type: 'task', priority: 1, label: 'urgent', assignee: 'agent-1' })

      const args = syncArgs()
      expect(args).toContain('list')
      expect(args).toContain('--status')
      expect(args[args.indexOf('--status') + 1]).toBe('open')
      expect(args).toContain('--type')
      expect(args[args.indexOf('--type') + 1]).toBe('task')
      expect(args).toContain('--priority')
      expect(args[args.indexOf('--priority') + 1]).toBe('1')
      expect(args).toContain('--label')
      expect(args[args.indexOf('--label') + 1]).toBe('urgent')
      expect(args).toContain('--assignee')
      expect(args[args.indexOf('--assignee') + 1]).toBe('agent-1')
      expect(args).toContain('--json')
    })

    it('returns empty array for non-array response', () => {
      mockExecFileSync.mockReturnValue(JSON.stringify({ not: 'an array' }))
      expect(client.list()).toEqual([])
    })
  })

  // ── listAll ────────────────────────────────────────────────────────────

  describe('listAll', () => {
    it('returns all beads when --all flag works', () => {
      mockExecFileSync.mockReturnValue(JSON.stringify([
        rawBead({ id: 'b1', status: 'open' }),
        rawBead({ id: 'b2', status: 'in_progress' }),
        rawBead({ id: 'b3', status: 'closed' }),
      ]))

      const result = client.listAll()

      expect(result).toHaveLength(3)
      expect(result[0]).toMatchObject({ id: 'b1', status: 'ready' })
      expect(result[1]).toMatchObject({ id: 'b2', status: 'claimed' })
      expect(result[2]).toMatchObject({ id: 'b3', status: 'done' })

      const args = syncArgs()
      expect(args).toEqual(expect.arrayContaining(['list', '--all', '--limit', '0', '--json']))
    })

    it('falls back to merging all statuses when --all fails', () => {
      let callCount = 0
      mockExecFileSync.mockImplementation((_cmd: string, args: string[]) => {
        callCount++
        if (callCount === 1) {
          // First call: list --all fails
          throw new Error('unknown flag --all')
        }
        // Subsequent calls: per-status queries
        if (args.includes('open')) {
          return JSON.stringify([rawBead({ id: 'b1', status: 'open' })])
        }
        if (args.includes('in_progress')) {
          return JSON.stringify([rawBead({ id: 'b2', status: 'in_progress', assignee: 'agent-0' })])
        }
        if (args.includes('closed')) {
          return JSON.stringify([rawBead({ id: 'b3', status: 'closed' })])
        }
        return '[]'
      })

      const result = client.listAll()

      expect(result).toHaveLength(3)
      expect(result[0]).toMatchObject({ id: 'b1', status: 'ready' })
      expect(result[1]).toMatchObject({ id: 'b2', status: 'claimed' })
      expect(result[2]).toMatchObject({ id: 'b3', status: 'done' })
    })

    it('deduplicates beads in fallback path', () => {
      let callCount = 0
      mockExecFileSync.mockImplementation((_cmd: string, args: string[]) => {
        callCount++
        if (callCount === 1) throw new Error('unknown flag --all')
        // Return the same bead from multiple queries
        if (args.includes('open')) {
          return JSON.stringify([rawBead({ id: 'dup-1', status: 'open' })])
        }
        if (args.includes('in_progress')) {
          return JSON.stringify([rawBead({ id: 'dup-1', status: 'open' })])
        }
        if (args.includes('closed')) {
          return JSON.stringify([])
        }
        return '[]'
      })

      const result = client.listAll()
      expect(result).toHaveLength(1)
      expect(result[0].id).toBe('dup-1')
    })

    it('returns empty array when --all returns non-array', () => {
      mockExecFileSync.mockReturnValue(JSON.stringify({ not: 'an array' }))
      expect(client.listAll()).toEqual([])
    })
  })

  // ── create ─────────────────────────────────────────────────────────────

  describe('create', () => {
    it('creates a bead with minimal options', () => {
      mockExecFileSync.mockReturnValue(JSON.stringify(rawBead({ id: 'new-1' })))

      const result = client.create({ title: 'New bead' })

      expect(result.id).toBe('new-1')
      const args = syncArgs()
      expect(args[0]).toBe('create')
      expect(args[1]).toBe('New bead')
      expect(args).toContain('--json')
    })

    it('passes all optional arguments', () => {
      mockExecFileSync.mockReturnValue(JSON.stringify(rawBead()))

      client.create({
        title: 'Full bead',
        type: 'epic',
        priority: 1,
        description: 'A description',
        labels: ['alpha', 'beta'],
        parentId: 'parent-1',
        id: 'custom-id',
      })

      const args = syncArgs()
      expect(args).toContain('-t')
      expect(args[args.indexOf('-t') + 1]).toBe('epic')
      expect(args).toContain('-p')
      expect(args[args.indexOf('-p') + 1]).toBe('1')
      expect(args).toContain('-d')
      expect(args[args.indexOf('-d') + 1]).toBe('A description')
      expect(args).toContain('-l')
      expect(args[args.indexOf('-l') + 1]).toBe('alpha,beta')
      expect(args).toContain('--parent')
      expect(args[args.indexOf('--parent') + 1]).toBe('parent-1')
      expect(args).toContain('--id')
      expect(args[args.indexOf('--id') + 1]).toBe('custom-id')
    })
  })

  // ── createAsync ────────────────────────────────────────────────────────

  describe('createAsync', () => {
    it('creates a bead asynchronously', async () => {
      mockExecFile.mockImplementation((_cmd: any, _args: any, _opts: any, cb: any) => {
        cb(null, JSON.stringify(rawBead({ id: 'async-1' })), '')
        return {} as any
      })

      const result = await client.createAsync({ title: 'Async bead' })
      expect(result.id).toBe('async-1')
    })

    it('rejects on exec error', async () => {
      mockExecFile.mockImplementation((_cmd: any, _args: any, _opts: any, cb: any) => {
        cb(new Error('spawn failed'), '', 'bd not found')
        return {} as any
      })

      await expect(client.createAsync({ title: 'Fail' }))
        .rejects.toThrow('bd create failed')
    })
  })

  // ── createMany ─────────────────────────────────────────────────────────

  describe('createMany', () => {
    it('returns created beads and empty failed array on full success', async () => {
      let callCount = 0
      mockExecFile.mockImplementation((_cmd: any, _args: any, _opts: any, cb: any) => {
        callCount++
        cb(null, JSON.stringify(rawBead({ id: `many-${callCount}` })), '')
        return {} as any
      })

      const result = await client.createMany([
        { title: 'First' },
        { title: 'Second' },
      ])

      expect(result.created).toHaveLength(2)
      expect(result.created[0].id).toBe('many-1')
      expect(result.created[1].id).toBe('many-2')
      expect(result.failed).toHaveLength(0)
    })

    it('returns partial results with failures on mixed outcomes', async () => {
      let callCount = 0
      mockExecFile.mockImplementation((_cmd: any, _args: any, _opts: any, cb: any) => {
        callCount++
        if (callCount === 1) {
          cb(new Error('fail'), '', 'bd create failed: spawn error')
        } else {
          cb(null, JSON.stringify(rawBead({ id: 'survived' })), '')
        }
        return {} as any
      })

      const result = await client.createMany([
        { title: 'Will fail' },
        { title: 'Will succeed' },
      ])

      expect(result.created).toHaveLength(1)
      expect(result.created[0].id).toBe('survived')
      expect(result.failed).toHaveLength(1)
      expect(result.failed[0].opts.title).toBe('Will fail')
      expect(result.failed[0].error).toContain('bd create failed')
    })

    it('returns all failures when every create fails', async () => {
      mockExecFile.mockImplementation((_cmd: any, _args: any, _opts: any, cb: any) => {
        cb(new Error('fail'), '', 'bd error')
        return {} as any
      })

      const result = await client.createMany([
        { title: 'Fail A' },
        { title: 'Fail B' },
      ])

      expect(result.created).toHaveLength(0)
      expect(result.failed).toHaveLength(2)
      expect(result.failed[0].opts.title).toBe('Fail A')
      expect(result.failed[1].opts.title).toBe('Fail B')
    })

    it('returns empty results for empty input', async () => {
      const result = await client.createMany([])

      expect(result.created).toHaveLength(0)
      expect(result.failed).toHaveLength(0)
    })

    it('preserves opts reference in failed entries', async () => {
      mockExecFile.mockImplementation((_cmd: any, _args: any, _opts: any, cb: any) => {
        cb(new Error('fail'), '', 'error')
        return {} as any
      })

      const inputOpts = { title: 'Test', priority: 1, labels: ['urgent'] }
      const result = await client.createMany([inputOpts])

      expect(result.failed[0].opts).toBe(inputOpts)
    })
  })

  // ── show ───────────────────────────────────────────────────────────────

  describe('show', () => {
    it('returns normalized bead', () => {
      mockExecFileSync.mockReturnValue(JSON.stringify(rawBead({ id: 'show-1' })))
      const result = client.show('show-1')
      expect(result).not.toBeNull()
      expect(result!.id).toBe('show-1')

      const args = syncArgs()
      expect(args).toContain('show')
      expect(args).toContain('show-1')
    })

    it('returns null on error', () => {
      mockExecFileSync.mockImplementation(() => { throw new Error('not found') })
      expect(client.show('missing')).toBeNull()
    })
  })

  // ── ready ──────────────────────────────────────────────────────────────

  describe('ready', () => {
    it('returns ready beads', () => {
      mockExecFileSync.mockReturnValue(JSON.stringify([
        rawBead({ id: 'r1', status: 'open' }),
      ]))

      const result = client.ready()
      expect(result).toHaveLength(1)
      expect(result[0].id).toBe('r1')
      expect(result[0].status).toBe('ready')
    })

    it('returns empty array on error', () => {
      mockExecFileSync.mockImplementation(() => { throw new Error('fail') })
      expect(client.ready()).toEqual([])
    })
  })

  // ── update ─────────────────────────────────────────────────────────────

  describe('update', () => {
    it('updates title', () => {
      mockExecFileSync.mockReturnValue('{}')
      client.update('u1', { title: 'New title' })

      const args = syncArgs()
      expect(args).toEqual(['update', 'u1', '--title', 'New title', '--json'])
    })

    it('updates priority', () => {
      mockExecFileSync.mockReturnValue('{}')
      client.update('u1', { priority: 3 })

      const args = syncArgs()
      expect(args).toEqual(['update', 'u1', '--priority', '3', '--json'])
    })

    it('claims a bead', () => {
      mockExecFileSync.mockReturnValue('{}')
      client.update('u1', { claim: true })

      const args = syncArgs()
      expect(args).toEqual(['update', 'u1', '--claim', '--json'])
    })

    it('unclaims a bead', () => {
      mockExecFileSync.mockReturnValue('{}')
      client.update('u1', { unclaim: true })

      const args = syncArgs()
      expect(args).toEqual(['update', 'u1', '--assignee', '', '--json'])
    })

    it('adds and removes labels', () => {
      mockExecFileSync.mockReturnValue('{}')
      client.update('u1', { labels: { add: ['bug'], remove: ['wip'] } })

      const allCalls = mockExecFileSync.mock.calls.map((c: any) => c[1] as string[])
      expect(allCalls.some((a: string[]) => a[0] === 'label' && a[1] === 'add' && a[2] === 'u1' && a[3] === 'bug')).toBe(true)
      expect(allCalls.some((a: string[]) => a[0] === 'label' && a[1] === 'remove' && a[2] === 'u1' && a[3] === 'wip')).toBe(true)
    })
  })

  // ── claim ──────────────────────────────────────────────────────────────

  describe('claim', () => {
    it('returns true on success', () => {
      mockExecFileSync.mockReturnValue('{}')
      expect(client.claim('c1')).toBe(true)
    })

    it('returns false on failure', () => {
      mockExecFileSync.mockImplementation(() => { throw new Error('already claimed') })
      expect(client.claim('c1')).toBe(false)
    })
  })

  // ── assignTo ───────────────────────────────────────────────────────────

  describe('assignTo', () => {
    it('claims and assigns', () => {
      mockExecFileSync.mockReturnValue('{}')
      expect(client.assignTo('a1', 'agent-5')).toBe(true)

      const args = syncArgs()
      expect(args).toContain('--claim')
      expect(args).toContain('-a')
      expect(args[args.indexOf('-a') + 1]).toBe('agent-5')
    })

    it('returns false if assign fails', () => {
      mockExecFileSync.mockImplementation(() => {
        throw new Error('fail')
      })
      expect(client.assignTo('a1', 'agent-5')).toBe(false)
    })
  })

  // ── close / reopen ────────────────────────────────────────────────────

  describe('close', () => {
    it('closes with default reason', () => {
      mockExecFileSync.mockReturnValue('{}')
      client.close('cl1')

      const args = syncArgs()
      expect(args).toEqual(['close', 'cl1', '--reason', 'Done', '--json'])
    })

    it('closes with custom reason', () => {
      mockExecFileSync.mockReturnValue('{}')
      client.close('cl1', 'Completed successfully')

      const args = syncArgs()
      expect(args).toContain('--reason')
      expect(args[args.indexOf('--reason') + 1]).toBe('Completed successfully')
    })
  })

  describe('reopen', () => {
    it('reopens and clears claim and failed label', () => {
      mockExecFileSync.mockReturnValue('{}')
      client.reopen('ro1', 'Retry')

      const allCalls = mockExecFileSync.mock.calls.map((c: any) => c[1] as string[])
      expect(allCalls[0]).toEqual(['reopen', 'ro1', '--reason', 'Retry', '--json'])
      expect(allCalls[1]).toEqual(['update', 'ro1', '--assignee', '', '--json'])
      expect(allCalls[2]).toEqual(['label', 'remove', 'ro1', 'failed', '--json'])
    })

    it('reopens without reason', () => {
      mockExecFileSync.mockReturnValue('{}')
      client.reopen('ro1')

      const args = syncArgs()
      expect(args).toEqual(['reopen', 'ro1', '--json'])
      expect(args).not.toContain('--reason')
    })
  })

  // ── labels ─────────────────────────────────────────────────────────────

  describe('labels', () => {
    it('addLabel calls correct CLI args', () => {
      mockExecFileSync.mockReturnValue('{}')
      client.addLabel('l1', 'urgent')

      const args = syncArgs()
      expect(args).toEqual(['label', 'add', 'l1', 'urgent', '--json'])
    })

    it('removeLabel calls correct CLI args', () => {
      mockExecFileSync.mockReturnValue('{}')
      client.removeLabel('l1', 'wip')

      const args = syncArgs()
      expect(args).toEqual(['label', 'remove', 'l1', 'wip', '--json'])
    })

    it('listLabels returns labels array', () => {
      mockExecFileSync.mockReturnValue(JSON.stringify(['bug', 'feature', 'urgent']))
      expect(client.listLabels()).toEqual(['bug', 'feature', 'urgent'])
    })

    it('listLabels returns empty array on error', () => {
      mockExecFileSync.mockImplementation(() => { throw new Error('fail') })
      expect(client.listLabels()).toEqual([])
    })
  })

  // ── dependencies ───────────────────────────────────────────────────────

  describe('dependencies', () => {
    it('addDep calls bd dep add with type', () => {
      mockExecFileSync.mockReturnValue('')
      client.addDep('child-1', 'parent-1', 'blocks')

      const args = syncArgs()
      expect(args).toEqual(['dep', 'add', 'child-1', 'parent-1', '--type', 'blocks'])
    })

    it('addDep uses default type', () => {
      mockExecFileSync.mockReturnValue('')
      client.addDep('child-1', 'parent-1')

      const args = syncArgs()
      expect(args).toContain('--type')
      expect(args[args.indexOf('--type') + 1]).toBe('discovered-from')
    })

    it('depTree returns tree string', () => {
      mockExecFileSync.mockReturnValue('root\n  child-1\n  child-2')
      expect(client.depTree('root')).toBe('root\n  child-1\n  child-2')
    })
  })

  // ── state management ──────────────────────────────────────────────────

  describe('state management', () => {
    it('getState returns dimension value', () => {
      mockExecFileSync.mockReturnValue('blocked')
      expect(client.getState('s1', 'workflow')).toBe('blocked')
    })

    it('getState returns empty string on error', () => {
      mockExecFileSync.mockImplementation(() => { throw new Error('fail') })
      expect(client.getState('s1', 'workflow')).toBe('')
    })

    it('setState calls bd set-state', () => {
      mockExecFileSync.mockReturnValue('{}')
      client.setState('s1', 'workflow', 'active', 'Starting work')

      const args = syncArgs()
      expect(args).toEqual(['set-state', 's1', 'workflow=active', '--reason', 'Starting work', '--json'])
    })

    it('setState without reason', () => {
      mockExecFileSync.mockReturnValue('{}')
      client.setState('s1', 'workflow', 'done')

      const args = syncArgs()
      expect(args).toEqual(['set-state', 's1', 'workflow=done', '--json'])
      expect(args).not.toContain('--reason')
    })
  })

  // ── stats ──────────────────────────────────────────────────────────────

  describe('stats', () => {
    it('computes stats from list', () => {
      mockExecFileSync.mockReturnValue(JSON.stringify([
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
      mockExecFileSync.mockReturnValue('[]')
      expect(client.stats().pct).toBe(0)
    })
  })

  // ── hasOpenWork ────────────────────────────────────────────────────────

  describe('hasOpenWork', () => {
    it('returns true when open beads exist', () => {
      mockExecFileSync.mockReturnValue(JSON.stringify([rawBead()]))
      expect(client.hasOpenWork()).toBe(true)
    })

    it('returns false when no open beads', () => {
      mockExecFileSync.mockReturnValue('[]')
      expect(client.hasOpenWork()).toBe(false)
    })
  })

  // ── check ──────────────────────────────────────────────────────────────

  describe('check', () => {
    it('returns available when bd is found and .beads exists', () => {
      // check() still uses execSync for 'which bd'
      const mockExecSync = vi.spyOn(cp, 'execSync').mockReturnValue('/usr/local/bin/bd')

      const fs = require('fs')
      const spy = vi.spyOn(fs, 'existsSync').mockReturnValue(true)

      const result = client.check()
      expect(result).toEqual({ available: true })

      spy.mockRestore()
      mockExecSync.mockRestore()
    })

    it('returns unavailable when bd not found', () => {
      const mockExecSync = vi.spyOn(cp, 'execSync').mockImplementation(() => { throw new Error('not found') })

      const result = client.check()
      expect(result.available).toBe(false)
      expect(result.reason).toContain('not found on PATH')

      mockExecSync.mockRestore()
    })

    it('uses enriched env for which command', () => {
      const mockExecSync = vi.spyOn(cp, 'execSync').mockReturnValue('/usr/local/bin/bd')

      const fs = require('fs')
      const spy = vi.spyOn(fs, 'existsSync').mockReturnValue(true)

      client.check()

      // The 'which bd' call should pass env with enriched PATH
      const whichCall = mockExecSync.mock.calls[0]
      const opts = whichCall[1] as Record<string, unknown>
      const env = opts.env as NodeJS.ProcessEnv
      expect(env.PATH).toContain('.local/share/mise/shims')

      spy.mockRestore()
      mockExecSync.mockRestore()
    })

    it('returns unavailable when .beads dir missing', () => {
      const mockExecSync = vi.spyOn(cp, 'execSync').mockReturnValue('/usr/local/bin/bd')

      const fs = require('fs')
      const spy = vi.spyOn(fs, 'existsSync').mockReturnValue(false)

      const result = client.check()
      expect(result.available).toBe(false)
      expect(result.reason).toContain('No .beads directory')

      spy.mockRestore()
      mockExecSync.mockRestore()
    })
  })

  // ── info ───────────────────────────────────────────────────────────────

  describe('info', () => {
    it('returns parsed JSON from bd info', () => {
      const infoData = { version: '1.2.3', project: 'test' }
      mockExecFileSync.mockReturnValue(JSON.stringify(infoData))

      expect(client.info()).toEqual(infoData)
    })
  })

  // ── normalizeBead (tested indirectly) ─────────────────────────────────

  describe('normalizeBead (via list/show)', () => {
    it('maps open status to ready', () => {
      mockExecFileSync.mockReturnValue(JSON.stringify([rawBead({ status: 'open' })]))
      expect(client.list()[0].status).toBe('ready')
    })

    it('maps in_progress status to claimed', () => {
      mockExecFileSync.mockReturnValue(JSON.stringify([rawBead({ status: 'in_progress' })]))
      expect(client.list()[0].status).toBe('claimed')
    })

    it('maps closed status to done', () => {
      mockExecFileSync.mockReturnValue(JSON.stringify([rawBead({ status: 'closed' })]))
      expect(client.list()[0].status).toBe('done')
    })

    it('maps unknown status to pending', () => {
      mockExecFileSync.mockReturnValue(JSON.stringify([rawBead({ status: 'weird' })]))
      expect(client.list()[0].status).toBe('pending')
    })

    it('overrides status to failed when label present', () => {
      mockExecFileSync.mockReturnValue(JSON.stringify([rawBead({ status: 'open', labels: ['failed'] })]))
      expect(client.list()[0].status).toBe('failed')
    })

    it('maps issue_type to bead type', () => {
      mockExecFileSync.mockReturnValue(JSON.stringify([rawBead({ issue_type: 'epic' })]))
      expect(client.list()[0].type).toBe('epic')

      mockExecFileSync.mockReturnValue(JSON.stringify([rawBead({ issue_type: 'subtask' })]))
      expect(client.list()[0].type).toBe('subtask')

      mockExecFileSync.mockReturnValue(JSON.stringify([rawBead({ issue_type: 'task' })]))
      expect(client.list()[0].type).toBe('task')
    })

    it('falls back to type field when issue_type missing', () => {
      mockExecFileSync.mockReturnValue(JSON.stringify([rawBead({ issue_type: undefined, type: 'epic' })]))
      expect(client.list()[0].type).toBe('epic')
    })

    it('handles array response (bd close returns array)', () => {
      mockExecFileSync.mockReturnValue(JSON.stringify([rawBead({ id: 'arr-1' })]))
      const result = client.show('arr-1')
      // show wraps single object, but if bd returns array the normalizer unwraps it
      expect(result).not.toBeNull()
    })

    it('maps body to description when description is missing', () => {
      mockExecFileSync.mockReturnValue(JSON.stringify([
        rawBead({ description: undefined, body: 'From body field' }),
      ]))
      expect(client.list()[0].description).toBe('From body field')
    })

    it('maps dependencies field as fallback for deps', () => {
      mockExecFileSync.mockReturnValue(JSON.stringify([
        rawBead({ deps: undefined, dependencies: [
          { depends_on_id: 'dep-1', type: 'discovered-from' },
          { depends_on_id: 'dep-2', type: 'discovered-from' },
        ] }),
      ]))
      const bead = client.list()[0]
      expect(bead.deps).toEqual(['dep-1', 'dep-2'])
    })

    it('defaults priority to 2 for non-numeric values', () => {
      mockExecFileSync.mockReturnValue(JSON.stringify([rawBead({ priority: 'high' })]))
      expect(client.list()[0].priority).toBe(2)
    })

    it('maps created_at to createdAt', () => {
      mockExecFileSync.mockReturnValue(JSON.stringify([rawBead({ created_at: '2026-03-20T10:00:00Z' })]))
      expect(client.list()[0].createdAt).toBe('2026-03-20T10:00:00Z')
    })

    it('falls back to created field when created_at is missing', () => {
      mockExecFileSync.mockReturnValue(JSON.stringify([rawBead({ created: '2026-03-19T08:00:00Z' })]))
      expect(client.list()[0].createdAt).toBe('2026-03-19T08:00:00Z')
    })

    it('prefers created_at over created fallback', () => {
      mockExecFileSync.mockReturnValue(JSON.stringify([rawBead({ created_at: '2026-03-20T10:00:00Z', created: '2026-03-19T08:00:00Z' })]))
      expect(client.list()[0].createdAt).toBe('2026-03-20T10:00:00Z')
    })

    it('leaves createdAt undefined when both created_at and created are missing', () => {
      mockExecFileSync.mockReturnValue(JSON.stringify([rawBead()]))
      expect(client.list()[0].createdAt).toBeUndefined()
    })

    it('maps all optional fields', () => {
      mockExecFileSync.mockReturnValue(JSON.stringify([rawBead({
        created_at: '2025-12-31',
        assignee: 'agent-3',
        claimed_at: '2026-01-01',
        closed_at: '2026-01-02',
        parent_id: 'epic-1',
        task_id: 'task-99',
        files: ['a.ts', 'b.ts'],
      })]))

      const bead = client.list()[0]
      expect(bead.createdAt).toBe('2025-12-31')
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
    it('wraps execFileSync errors with command context', () => {
      const err = new Error('command failed') as Error & { stderr: string }
      err.stderr = 'bd: permission denied'
      mockExecFileSync.mockImplementation(() => { throw err })

      expect(() => client.list()).toThrow('bd list failed: bd: permission denied')
    })

    it('falls back to error message when stderr missing', () => {
      mockExecFileSync.mockImplementation(() => { throw new Error('ENOENT') })
      expect(() => client.list()).toThrow('bd list failed: ENOENT')
    })

    it('handles non-Error throws', () => {
      mockExecFileSync.mockImplementation(() => { throw 'string error' })
      expect(() => client.list()).toThrow('bd list failed: string error')
    })

    it('throws on invalid JSON', () => {
      mockExecFileSync.mockReturnValue('not json at all')
      expect(() => client.list()).toThrow()
    })

    it('passes correct exec options with enriched PATH', () => {
      mockExecFileSync.mockReturnValue('[]')
      client.list()

      const opts = mockExecFileSync.mock.calls[0][2] as Record<string, unknown>
      expect(opts.cwd).toBe('/fake/project')
      expect(opts.timeout).toBe(15_000)
      expect(opts.encoding).toBe('utf8')
      // ENV should come from buildEnv() and include mise shims
      const env = opts.env as NodeJS.ProcessEnv
      expect(env.PATH).toContain('.local/share/mise/shims')
    })

    it('uses custom bd command name', () => {
      const custom = new BdClient('/fake', 'custom-bd')
      mockExecFileSync.mockReturnValue('[]')
      custom.list()

      // execFileSync(cmd, args, opts) — cmd is first arg
      const cmd = mockExecFileSync.mock.calls[0][0] as string
      expect(cmd).toBe('custom-bd')
    })
  })

  // ── shell injection prevention ─────────────────────────────────────────

  describe('shell injection prevention', () => {
    it('passes shell metacharacters in type field as literal array elements', () => {
      mockExecFileSync.mockReturnValue(JSON.stringify([rawBead()]))

      // If this were passed through a shell, the semicolon would execute 'rm -rf /'
      client.list({ type: 'task; rm -rf /' })

      // With execFileSync(cmd, args), each element is a separate argv entry — no shell parsing
      const args = syncArgs()
      expect(args).toContain('--type')
      expect(args[args.indexOf('--type') + 1]).toBe('task; rm -rf /')
      // Verify it's using execFileSync (array form), not execSync (string form)
      expect(mockExecFileSync).toHaveBeenCalled()
    })

    it('passes shell metacharacters in create title without shell interpretation', () => {
      mockExecFileSync.mockReturnValue(JSON.stringify(rawBead()))

      client.create({ title: '$(whoami) && echo pwned' })

      const args = syncArgs()
      expect(args[0]).toBe('create')
      expect(args[1]).toBe('$(whoami) && echo pwned')
    })

    it('passes shell metacharacters in label field safely', () => {
      mockExecFileSync.mockReturnValue(JSON.stringify([rawBead()]))

      client.list({ label: '`cat /etc/passwd`' })

      const args = syncArgs()
      expect(args[args.indexOf('--label') + 1]).toBe('`cat /etc/passwd`')
    })

    it('passes shell metacharacters in assignee field safely', () => {
      mockExecFileSync.mockReturnValue(JSON.stringify([rawBead()]))

      client.list({ assignee: 'agent-0 | cat /etc/shadow' })

      const args = syncArgs()
      expect(args[args.indexOf('--assignee') + 1]).toBe('agent-0 | cat /etc/shadow')
    })

    it('passes shell metacharacters in description safely', () => {
      mockExecFileSync.mockReturnValue(JSON.stringify(rawBead()))

      client.create({
        title: 'test',
        description: 'foo\n$(rm -rf /)\nbar',
      })

      const args = syncArgs()
      expect(args[args.indexOf('-d') + 1]).toBe('foo\n$(rm -rf /)\nbar')
    })

    it('passes shell metacharacters in create id safely', () => {
      mockExecFileSync.mockReturnValue(JSON.stringify(rawBead()))

      client.create({
        title: 'test',
        id: 'id-$(whoami)',
      })

      const args = syncArgs()
      expect(args[args.indexOf('--id') + 1]).toBe('id-$(whoami)')
    })

    it('passes shell metacharacters in parentId safely', () => {
      mockExecFileSync.mockReturnValue(JSON.stringify(rawBead()))

      client.create({
        title: 'test',
        parentId: 'parent; echo hacked',
      })

      const args = syncArgs()
      expect(args[args.indexOf('--parent') + 1]).toBe('parent; echo hacked')
    })

    it('passes shell metacharacters in labels safely', () => {
      mockExecFileSync.mockReturnValue(JSON.stringify(rawBead()))

      client.create({
        title: 'test',
        labels: ['label$(whoami)', 'normal'],
      })

      const args = syncArgs()
      expect(args[args.indexOf('-l') + 1]).toBe('label$(whoami),normal')
    })

    it('passes shell metacharacters in async operations safely', async () => {
      mockExecFile.mockImplementation((_cmd: any, _args: any, _opts: any, cb: any) => {
        cb(null, JSON.stringify(rawBead()), '')
        return {} as any
      })

      await client.createAsync({ title: '$(id)' })

      const args = asyncArgs()
      expect(args[1]).toBe('$(id)')
    })
  })

  // ── memories ──────────────────────────────────────────────────────────

  describe('memories', () => {
    it('returns normalized BdMemory array from flat map', () => {
      mockExecFileSync.mockReturnValue(JSON.stringify({
        'auth-jwt': 'auth module uses JWT not sessions',
        'dolt-phantoms': 'Dolt phantom DBs hide in three places',
      }))

      const result = client.memories()
      expect(result).toHaveLength(2)
      expect(result).toContainEqual({ key: 'auth-jwt', text: 'auth module uses JWT not sessions' })
      expect(result).toContainEqual({ key: 'dolt-phantoms', text: 'Dolt phantom DBs hide in three places' })

      const args = syncArgs()
      expect(args).toContain('memories')
      expect(args).toContain('--json')
    })

    it('returns empty array when no memories exist', () => {
      mockExecFileSync.mockReturnValue('{}')
      expect(client.memories()).toEqual([])
    })

    it('returns empty array on error', () => {
      mockExecFileSync.mockImplementation(() => { throw new Error('fail') })
      expect(client.memories()).toEqual([])
    })

    it('returns empty array for non-object response', () => {
      mockExecFileSync.mockReturnValue('null')
      expect(client.memories()).toEqual([])
    })
  })

  describe('memoriesAsync', () => {
    it('returns normalized BdMemory array', async () => {
      mockExecFile.mockImplementation((_cmd: any, _args: any, _opts: any, cb: any) => {
        cb(null, JSON.stringify({ 'key-1': 'value-1' }), '')
        return {} as any
      })

      const result = await client.memoriesAsync()
      expect(result).toEqual([{ key: 'key-1', text: 'value-1' }])
    })

    it('returns empty array on error', async () => {
      mockExecFile.mockImplementation((_cmd: any, _args: any, _opts: any, cb: any) => {
        cb(new Error('fail'), '', 'fail')
        return {} as any
      })

      expect(await client.memoriesAsync()).toEqual([])
    })
  })

  // ── remember ────────────────────────────────────────────────────────

  describe('remember', () => {
    it('stores a memory without key', () => {
      const response = { action: 'remembered', key: 'auto-key', value: 'test insight' }
      mockExecFileSync.mockReturnValue(JSON.stringify(response))

      const result = client.remember('test insight')
      expect(result).toEqual(response)

      const args = syncArgs()
      expect(args).toEqual(['remember', 'test insight', '--json'])
    })

    it('stores a memory with explicit key', () => {
      const response = { action: 'remembered', key: 'my-key', value: 'test insight' }
      mockExecFileSync.mockReturnValue(JSON.stringify(response))

      const result = client.remember('test insight', 'my-key')
      expect(result).toEqual(response)

      const args = syncArgs()
      expect(args).toEqual(['remember', 'test insight', '--key', 'my-key', '--json'])
    })
  })

  describe('rememberAsync', () => {
    it('stores a memory asynchronously', async () => {
      const response = { action: 'remembered', key: 'k', value: 'v' }
      mockExecFile.mockImplementation((_cmd: any, _args: any, _opts: any, cb: any) => {
        cb(null, JSON.stringify(response), '')
        return {} as any
      })

      const result = await client.rememberAsync('v', 'k')
      expect(result).toEqual(response)

      const args = asyncArgs()
      expect(args).toEqual(['remember', 'v', '--key', 'k', '--json'])
    })
  })

  // ── forget ──────────────────────────────────────────────────────────

  describe('forget', () => {
    it('removes a memory by key', () => {
      const response = { deleted: 'true', key: 'old-key' }
      mockExecFileSync.mockReturnValue(JSON.stringify(response))

      const result = client.forget('old-key')
      expect(result).toEqual(response)

      const args = syncArgs()
      expect(args).toEqual(['forget', 'old-key', '--json'])
    })
  })

  describe('forgetAsync', () => {
    it('removes a memory asynchronously', async () => {
      const response = { deleted: 'true', key: 'old-key' }
      mockExecFile.mockImplementation((_cmd: any, _args: any, _opts: any, cb: any) => {
        cb(null, JSON.stringify(response), '')
        return {} as any
      })

      const result = await client.forgetAsync('old-key')
      expect(result).toEqual(response)
    })
  })

  // ── comments ────────────────────────────────────────────────────────

  describe('comments', () => {
    it('returns normalized BdComment array', () => {
      mockExecFileSync.mockReturnValue(JSON.stringify([
        {
          id: 'c1',
          issue_id: 'bead-1',
          author: 'slashbin',
          text: 'Working on this',
          created_at: '2026-04-10T07:00:00Z',
        },
      ]))

      const result = client.comments('bead-1')
      expect(result).toHaveLength(1)
      expect(result[0]).toEqual({
        id: 'c1',
        issueId: 'bead-1',
        author: 'slashbin',
        text: 'Working on this',
        createdAt: '2026-04-10T07:00:00Z',
      })

      const args = syncArgs()
      expect(args).toContain('comments')
      expect(args).toContain('bead-1')
      expect(args).toContain('--json')
    })

    it('returns empty array when no comments', () => {
      mockExecFileSync.mockReturnValue('[]')
      expect(client.comments('bead-1')).toEqual([])
    })

    it('returns empty array on error', () => {
      mockExecFileSync.mockImplementation(() => { throw new Error('fail') })
      expect(client.comments('bead-1')).toEqual([])
    })
  })

  describe('commentsAsync', () => {
    it('returns normalized BdComment array', async () => {
      mockExecFile.mockImplementation((_cmd: any, _args: any, _opts: any, cb: any) => {
        cb(null, JSON.stringify([{ id: 'c1', issue_id: 'b1', author: 'a', text: 't', created_at: '2026-01-01' }]), '')
        return {} as any
      })

      const result = await client.commentsAsync('b1')
      expect(result).toHaveLength(1)
      expect(result[0].issueId).toBe('b1')
    })

    it('returns empty array on error', async () => {
      mockExecFile.mockImplementation((_cmd: any, _args: any, _opts: any, cb: any) => {
        cb(new Error('fail'), '', 'fail')
        return {} as any
      })

      expect(await client.commentsAsync('b1')).toEqual([])
    })
  })

  // ── addComment ──────────────────────────────────────────────────────

  describe('addComment', () => {
    it('adds a comment and returns normalized BdComment', () => {
      mockExecFileSync.mockReturnValue(JSON.stringify({
        id: 'c-new',
        issue_id: 'bead-1',
        author: 'slashbin',
        text: 'New comment',
        created_at: '2026-04-10T08:00:00Z',
      }))

      const result = client.addComment('bead-1', 'New comment')
      expect(result).toEqual({
        id: 'c-new',
        issueId: 'bead-1',
        author: 'slashbin',
        text: 'New comment',
        createdAt: '2026-04-10T08:00:00Z',
      })

      const args = syncArgs()
      expect(args).toEqual(['comment', 'bead-1', 'New comment', '--json'])
    })
  })

  describe('addCommentAsync', () => {
    it('adds a comment asynchronously', async () => {
      mockExecFile.mockImplementation((_cmd: any, _args: any, _opts: any, cb: any) => {
        cb(null, JSON.stringify({ id: 'c2', issue_id: 'b1', author: 'a', text: 'async comment', created_at: '2026-01-01' }), '')
        return {} as any
      })

      const result = await client.addCommentAsync('b1', 'async comment')
      expect(result.id).toBe('c2')
      expect(result.text).toBe('async comment')

      const args = asyncArgs()
      expect(args).toEqual(['comment', 'b1', 'async comment', '--json'])
    })
  })

  // ── Dolt restart failure propagation ─────────────────────────────────

  describe('Dolt restart failure propagation', () => {
    it('sync run propagates Dolt restart failure when restart also fails', () => {
      // First call: command fails with a Dolt server error
      // Second call: dolt start also fails
      mockExecFileSync
        .mockImplementationOnce(() => { throw new Error('bd list failed: connection refused ECONNREFUSED') })
        .mockImplementationOnce(() => { throw new Error('dolt start: port in use') })

      expect(() => client.list()).toThrow('Dolt restart failed: dolt start: port in use')
    })

    it('sync run succeeds after Dolt restart recovers', () => {
      // First call: fails with Dolt error
      // Second call (dolt start): succeeds
      // Third call (retry): succeeds
      mockExecFileSync
        .mockImplementationOnce(() => { throw new Error('bd list failed: ECONNREFUSED') })
        .mockImplementationOnce(() => '') // dolt start succeeds
        .mockReturnValue(JSON.stringify([rawBead()]))

      const result = client.list()
      expect(result).toHaveLength(1)
      expect(result[0].id).toBe('abc-123')
    })

    it('async run propagates Dolt restart failure', async () => {
      // First async call: fails with Dolt error
      mockExecFile.mockImplementation((_cmd: string, args: string[], _opts: any, cb: any) => {
        if (args[0] === 'dolt') {
          cb(new Error('dolt start: timeout'), '', 'dolt start: timeout')
        } else {
          cb(new Error('ECONNREFUSED'), '', 'ECONNREFUSED')
        }
        return {} as any
      })

      await expect(client.runPublicAsync(['list'])).rejects.toThrow('Dolt restart failed')
    })

    it('async run retries successfully after Dolt restart', async () => {
      let callCount = 0
      mockExecFile.mockImplementation((_cmd: string, args: string[], _opts: any, cb: any) => {
        callCount++
        if (args[0] === 'dolt') {
          cb(null, '', '') // dolt start succeeds
        } else if (callCount === 1) {
          cb(new Error('ECONNREFUSED'), '', 'ECONNREFUSED') // first call fails
        } else {
          cb(null, 'ok', '') // retry succeeds
        }
        return {} as any
      })

      const result = await client.runPublicAsync(['list'])
      expect(result).toBe('ok')
    })
  })
})
