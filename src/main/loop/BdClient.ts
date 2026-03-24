import * as cp from 'child_process'
import { Bead, BeadStats, BeadType, CreateBeadOpts, CreateManyResult } from '../types'
import { buildEnv } from './utils'


/**
 * Client wrapper around the `bd` CLI (beads-rust).
 * All bead operations go through the bd binary — no local SQLite.
 */
export class BdClient {
  constructor(
    private cwd: string,
    private bdCmd = 'bd'
  ) {}

  // ── Helpers ──────────────────────────────────────────────────────────────

  private run(args: string[]): string {
    try {
      return cp.execFileSync(this.bdCmd, args, {
        cwd: this.cwd,
        env: buildEnv(),
        timeout: 15_000,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe']
      }).trim()
    } catch (err) {
      const msg = err instanceof Error ? (err as { stderr?: string }).stderr || err.message : String(err)
      throw new Error(`bd ${args[0]} failed: ${msg}`)
    }
  }

  private runJson<T>(args: string[]): T {
    const raw = this.run([...args, '--json'])
    if (!raw) return [] as unknown as T // bd returns empty output when no results
    return JSON.parse(raw) as T
  }

  private async runAsync(args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      cp.execFile(this.bdCmd, args, {
        cwd: this.cwd,
        env: buildEnv(),
        timeout: 30_000
      }, (err, stdout, stderr) => {
        if (err) {
          reject(new Error(`bd ${args[0]} failed: ${stderr || err.message}`))
        } else {
          resolve(stdout.trim())
        }
      })
    })
  }

  private async runJsonAsync<T>(args: string[]): Promise<T> {
    const raw = await this.runAsync([...args, '--json'])
    if (!raw) return [] as unknown as T // bd returns empty output when no results
    return JSON.parse(raw) as T
  }

  // ── Availability check ─────────────────────────────────────────────────

  check(): { available: boolean; reason?: string } {
    try {
      cp.execSync('which bd', { env: buildEnv(), timeout: 3000, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch {
      return { available: false, reason: '`bd` command not found on PATH. Install from: https://github.com/steveyegge/beads' }
    }
    // Also check if beads is initialized in this project
    const { existsSync } = require('fs')
    const { join } = require('path')
    if (!existsSync(join(this.cwd, '.beads'))) {
      return { available: false, reason: 'No .beads directory found. Run `bd init` in this project.' }
    }
    return { available: true }
  }

  async checkAsync(): Promise<{ available: boolean; reason?: string }> {
    try {
      await new Promise<void>((resolve, reject) => {
        cp.exec('which bd', { env: buildEnv(), timeout: 3000 }, (err) => err ? reject(err) : resolve())
      })
    } catch {
      return { available: false, reason: '`bd` command not found on PATH. Install from: https://github.com/steveyegge/beads' }
    }
    const { existsSync } = require('fs')
    const { join } = require('path')
    if (!existsSync(join(this.cwd, '.beads'))) {
      return { available: false, reason: 'No .beads directory found. Run `bd init` in this project.' }
    }
    return { available: true }
  }

  info(): Record<string, unknown> {
    return this.runJson(['info'])
  }

  // ── Create ─────────────────────────────────────────────────────────────

  private buildCreateArgs(opts: CreateBeadOpts): string[] {
    const args = ['create', opts.title]
    if (opts.type) args.push('-t', opts.type)
    if (opts.priority !== undefined) args.push('-p', String(opts.priority))
    if (opts.description) args.push('-d', opts.description)
    if (opts.labels?.length) args.push('-l', opts.labels.join(','))
    if (opts.parentId) args.push('--parent', opts.parentId)
    if (opts.id) args.push('--id', opts.id)
    return args
  }

  create(opts: CreateBeadOpts): Bead {
    return this.normalizeBead(this.runJson(this.buildCreateArgs(opts)))
  }

  async createAsync(opts: CreateBeadOpts): Promise<Bead> {
    return this.normalizeBead(await this.runJsonAsync(this.buildCreateArgs(opts)))
  }

  // ── Bulk create (for plan encoding) ────────────────────────────────────

  async createMany(beads: CreateBeadOpts[]): Promise<CreateManyResult> {
    const created: Bead[] = []
    const failed: CreateManyResult['failed'] = []
    for (const b of beads) {
      try {
        const bead = await this.createAsync(b)
        created.push(bead)
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err)
        failed.push({ opts: b, error })
      }
    }
    return { created, failed }
  }

  // ── List / Query ───────────────────────────────────────────────────────

  list(filter?: {
    status?: string
    type?: string
    priority?: number
    label?: string
    assignee?: string
  }): Bead[] {
    const args = ['list', '--limit', '0']
    if (filter?.status) args.push('--status', filter.status)
    if (filter?.type) args.push('--type', filter.type)
    if (filter?.priority !== undefined) args.push('--priority', String(filter.priority))
    if (filter?.label) args.push('--label', filter.label)
    if (filter?.assignee) args.push('--assignee', filter.assignee)
    const raw = this.runJson<unknown[]>(args)
    return Array.isArray(raw) ? raw.map(b => this.normalizeBead(b)) : []
  }

  async listAsync(filter?: {
    status?: string
    type?: string
    priority?: number
    label?: string
    assignee?: string
  }): Promise<Bead[]> {
    const args = ['list', '--limit', '0']
    if (filter?.status) args.push('--status', filter.status)
    if (filter?.type) args.push('--type', filter.type)
    if (filter?.priority !== undefined) args.push('--priority', String(filter.priority))
    if (filter?.label) args.push('--label', filter.label)
    if (filter?.assignee) args.push('--assignee', filter.assignee)
    try {
      const raw = await this.runJsonAsync<unknown[]>(args)
      return Array.isArray(raw) ? raw.map(b => this.normalizeBead(b)) : []
    } catch { return [] }
  }

  listAll(): Bead[] {
    try {
      const raw = this.runJson<unknown[]>(['list', '--all', '--limit', '0'])
      return Array.isArray(raw) ? raw.map(b => this.normalizeBead(b)) : []
    } catch {
      // Fallback: merge results from all statuses when --all is not supported
      const open = this.list({ status: 'open' })
      const inProgress = this.list({ status: 'in_progress' })
      const closed = this.list({ status: 'closed' })
      // Deduplicate by id in case of overlap
      const seen = new Set<string>()
      const result: Bead[] = []
      for (const bead of [...open, ...inProgress, ...closed]) {
        if (!seen.has(bead.id)) {
          seen.add(bead.id)
          result.push(bead)
        }
      }
      return result
    }
  }

  listByStatus(status: string): Bead[] {
    return this.list({ status })
  }

  /** Get unblocked, unclaimed beads ready for work */
  ready(): Bead[] {
    try {
      const raw = this.runJson<unknown[]>(['ready'])
      return Array.isArray(raw) ? raw.map(b => this.normalizeBead(b)) : []
    } catch {
      return []
    }
  }

  // ── Truly async variants (cp.exec, non-blocking) ───────────────────────
  // These use cp.exec (callback-based) to avoid blocking the Electron event loop.

  async readyAsync(): Promise<Bead[]> {
    try {
      const raw = await this.runJsonAsync<unknown[]>(['ready'])
      return Array.isArray(raw) ? raw.map(b => this.normalizeBead(b)) : []
    } catch { return [] }
  }

  async listByStatusAsync(status: string): Promise<Bead[]> {
    const raw = await this.runJsonAsync<unknown[]>(['list', '--limit', '0', '--status', status])
    return Array.isArray(raw) ? raw.map(b => this.normalizeBead(b)) : []
  }

  async listAllAsync(): Promise<Bead[]> {
    try {
      const raw = await this.runJsonAsync<unknown[]>(['list', '--all', '--limit', '0'])
      return Array.isArray(raw) ? raw.map(b => this.normalizeBead(b)) : []
    } catch {
      const [open, inProgress, closed] = await Promise.all([
        this.listByStatusAsync('open'),
        this.listByStatusAsync('in_progress'),
        this.listByStatusAsync('closed'),
      ])
      const seen = new Set<string>()
      const result: Bead[] = []
      for (const bead of [...open, ...inProgress, ...closed]) {
        if (!seen.has(bead.id)) { seen.add(bead.id); result.push(bead) }
      }
      return result
    }
  }

  async assignToAsync(id: string, assignee: string): Promise<boolean> {
    await this.runAsync(['update', id, '--claim', '-a', assignee, '--json'])
    return true
  }

  async showAsync(id: string): Promise<Bead | null> {
    try {
      const raw = await this.runJsonAsync<unknown>(['show', id])
      return this.normalizeBead(raw)
    } catch { return null }
  }

  async getStateAsync(id: string, key: string): Promise<string> {
    try { return await this.runAsync(['state', id, key]) }
    catch { return '' }
  }

  // ── Show ───────────────────────────────────────────────────────────────

  show(id: string): Bead | null {
    try {
      return this.normalizeBead(this.runJson(['show', id]))
    } catch {
      return null
    }
  }

  // ── Update ─────────────────────────────────────────────────────────────

  update(id: string, opts: {
    priority?: number
    claim?: boolean
    unclaim?: boolean
    title?: string
    description?: string
    labels?: { add?: string[]; remove?: string[] }
  }): void {
    if (opts.title) {
      this.run(['update', id, '--title', opts.title, '--json'])
    }
    if (opts.description !== undefined) {
      this.run(['update', id, '--description', opts.description, '--json'])
    }
    if (opts.unclaim) {
      this.run(['update', id, '--assignee', '', '--json'])
    }
    if (opts.priority !== undefined) {
      this.run(['update', id, '--priority', String(opts.priority), '--json'])
    }
    if (opts.claim) {
      this.run(['update', id, '--claim', '--json'])
    }
    if (opts.labels?.add) {
      for (const l of opts.labels.add) this.run(['label', 'add', id, l, '--json'])
    }
    if (opts.labels?.remove) {
      for (const l of opts.labels.remove) this.run(['label', 'remove', id, l, '--json'])
    }
  }

  /** Atomic claim — fails if already claimed by someone else */
  claim(id: string): boolean {
    try {
      this.run(['update', id, '--claim', '--json'])
      return true
    } catch {
      return false
    }
  }

  /** Claim a bead for a specific agent (sets status to in_progress + assignee) */
  assignTo(id: string, assignee: string): boolean {
    try {
      this.run(['update', id, '--claim', '-a', assignee, '--json'])
      return true
    } catch {
      return false
    }
  }

  // ── Close / Reopen ─────────────────────────────────────────────────────

  close(id: string, reason = 'Done'): void {
    this.run(['close', id, '--reason', reason, '--json'])
  }

  async closeAsync(id: string, reason = 'Done'): Promise<void> {
    await this.runAsync(['close', id, '--reason', reason, '--json'])
  }

  reopen(id: string, reason = ''): void {
    const args = ['reopen', id]
    if (reason) args.push('--reason', reason)
    args.push('--json')
    this.run(args)
    // Clear claim so agents can pick it up
    try { this.run(['update', id, '--assignee', '', '--json']) } catch { /* ignore */ }
    // Remove 'failed' label so normalizeBead doesn't override the open status
    try { this.run(['label', 'remove', id, 'failed', '--json']) } catch { /* label may not exist */ }
  }

  async reopenAsync(id: string, reason = ''): Promise<void> {
    const args = ['reopen', id]
    if (reason) args.push('--reason', reason)
    args.push('--json')
    await this.runAsync(args)
    try { await this.runAsync(['update', id, '--assignee', '', '--json']) } catch { /* ignore */ }
    try { await this.runAsync(['label', 'remove', id, 'failed', '--json']) } catch { /* label may not exist */ }
  }

  // ── Labels ─────────────────────────────────────────────────────────────

  addLabel(id: string, label: string): void {
    this.run(['label', 'add', id, label, '--json'])
  }

  async addLabelAsync(id: string, label: string): Promise<void> {
    await this.runAsync(['label', 'add', id, label, '--json'])
  }

  removeLabel(id: string, label: string): void {
    this.run(['label', 'remove', id, label, '--json'])
  }

  listLabels(): string[] {
    try {
      return this.runJson<string[]>(['label', 'list-all'])
    } catch {
      return []
    }
  }

  // ── Dependencies ───────────────────────────────────────────────────────

  addDep(childId: string, parentId: string, type = 'discovered-from'): void {
    this.run(['dep', 'add', childId, parentId, '--type', type])
  }

  depTree(id: string): string {
    return this.run(['dep', 'tree', id])
  }

  // ── State management ──────────────────────────────────────────────────

  getState(id: string, dimension: string): string {
    try {
      return this.run(['state', id, dimension])
    } catch {
      return ''
    }
  }

  setState(id: string, dimension: string, value: string, reason?: string): void {
    const args = ['set-state', id, `${dimension}=${value}`]
    if (reason) args.push('--reason', reason)
    args.push('--json')
    this.run(args)
  }

  // ── Stats (computed from list) ────────────────────────────────────────

  stats(): BeadStats {
    const all = this.listAll()
    return this.computeStats(all)
  }

  async statsAsync(): Promise<BeadStats> {
    const all = await this.listAllAsync()
    return this.computeStats(all)
  }

  private computeStats(all: Bead[]): BeadStats {
    const total = all.length
    const done = all.filter(b => b.status === 'done').length
    return {
      total,
      pending: all.filter(b => b.status === 'pending').length,
      ready: all.filter(b => b.status === 'ready' || b.status === 'pending').length,
      claimed: all.filter(b => b.status === 'claimed').length,
      done,
      failed: all.filter(b => b.status === 'failed').length,
      pct: total > 0 ? Math.round((done / total) * 100) : 0
    }
  }

  hasOpenWork(): boolean {
    const all = this.list({ status: 'open' })
    return all.length > 0
  }

  // ── Normalize bd JSON output to our Bead type ────────────────────────

  /**
   * Normalize bd JSON output to our Bead type.
   * bd outputs: { id, title, status, priority, issue_type, owner, created_at, ... }
   * bd close returns an array; bd create returns a single object.
   */
  private normalizeBead(raw: unknown): Bead {
    // bd close returns an array — unwrap it
    const r = (Array.isArray(raw) ? raw[0] : raw) as Record<string, unknown>

    // bd statuses: open, in_progress, closed
    let status: Bead['status'] = 'pending'
    const bdStatus = String(r.status ?? 'open')
    if (bdStatus === 'open') status = 'ready'
    else if (bdStatus === 'in_progress') status = 'claimed'
    else if (bdStatus === 'closed') status = 'done'

    // Check labels for failed
    const labels = Array.isArray(r.labels) ? r.labels.map(String) : []
    if (labels.includes('failed')) status = 'failed'

    // bd uses "issue_type" not "type"
    const issueType = String(r.issue_type ?? r.type ?? 'task')
    let beadType: Bead['type'] = 'task'
    if (issueType === 'epic') beadType = 'epic'
    else if (issueType === 'subtask') beadType = 'subtask'

    return {
      id: String(r.id ?? ''),
      title: String(r.title ?? ''),
      description: String(r.description ?? r.body ?? ''),
      type: beadType,
      status,
      deps: Array.isArray(r.deps) ? r.deps.map(String)
        : Array.isArray(r.dependencies)
          ? (r.dependencies as Record<string, unknown>[])
              .filter(d => d.type !== 'parent-child')
              .map(d => String(d.depends_on_id ?? ''))
              .filter(Boolean)
          : [],
      files: Array.isArray(r.files) ? r.files.map(String) : [],
      priority: typeof r.priority === 'number' ? r.priority : 2,
      tags: labels,
      createdAt: r.created_at ? String(r.created_at) : r.created ? String(r.created) : undefined,
      claimedBy: r.assignee ? String(r.assignee) : undefined,
      claimedAt: r.claimed_at ? String(r.claimed_at) : undefined,
      completedAt: r.closed_at ? String(r.closed_at) : undefined,
      epicId: r.parent_id ? String(r.parent_id) : r.parent ? String(r.parent) : undefined,
      taskId: r.task_id ? String(r.task_id) : undefined,
    }
  }
}
