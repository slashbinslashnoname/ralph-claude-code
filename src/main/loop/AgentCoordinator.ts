/**
 * AgentCoordinator.ts — coordination layer for multi-agent swarm.
 *
 * Responsibilities:
 *  • File locking — prevents two agents touching the same file
 *  • Agent registry — tracks all active agents and their current bead
 *  • Agent mail — append-only broadcast log so agents stay aware of each other
 *  • Claim / release cycle for beads
 *
 * All state is persisted to disk so every worker reads a consistent view.
 * Mutex-style safety: claim attempts re-read from disk each time so a race
 * between two workers resolves deterministically (last writer loses the race
 * and will retry on the next routing tick).
 */

import {
  readFileSync, writeFileSync, existsSync, appendFileSync, mkdirSync
} from 'fs'
import { join, dirname } from 'path'
import { execSync, spawnSync } from 'child_process'
import { Bead, BeadGraph, BeadType, loadGraph } from './Bead'

// ── bd helpers ─────────────────────────────────────────────────────────────

function bdEnv(): Record<string, string> {
  const extras = [
    '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin',
    '/opt/homebrew/bin', '/opt/homebrew/sbin',
    `${process.env.HOME ?? ''}/.local/bin`,
    `${process.env.HOME ?? ''}/.npm-global/bin`,
  ]
  let loginPath = ''
  try { loginPath = execSync('bash -l -c "echo $PATH"', { timeout: 3000 }).toString().trim() } catch { /* ignore */ }
  const merged = [...new Set(
    [process.env.PATH ?? '', loginPath, ...extras].flatMap(p => p.split(':').filter(Boolean))
  )].join(':')
  return { ...process.env, PATH: merged } as Record<string, string>
}

function bdRun(args: string[], cwd: string): { stdout: string; ok: boolean } {
  const r = spawnSync('bd', args, { cwd, env: bdEnv(), timeout: 15_000, encoding: 'utf8' })
  return { stdout: r.stdout ?? '', ok: r.status === 0 }
}

function parseBeadFiles(raw: Record<string, unknown>): string[] {
  const desc = String(raw['description'] ?? '')
  const match = desc.match(/FILES:\s*([^\n]+)/)
  if (!match) return []
  return match[1].split(',').map(f => f.trim()).filter(Boolean)
}

function mapBdBead(raw: Record<string, unknown>, files: string[]): Bead {
  const t = String(raw['type'] ?? 'task')
  const bdP = Number(raw['priority'] ?? 2)
  return {
    id:          String(raw['id'] ?? ''),
    title:       String(raw['title'] ?? ''),
    description: String(raw['description'] ?? '').replace(/\nFILES:.*$/m, '').trim(),
    type:        (t === 'epic' ? 'epic' : 'task') as BeadType,
    status:      'claimed',
    deps:        [],
    files,
    priority:    Math.round(bdP / 4 * 9) + 1,
    tags:        Array.isArray(raw['labels']) ? (raw['labels'] as unknown[]).map(String) : [],
  }
}

// ── File lock types ────────────────────────────────────────────────────────

export interface FileReservation {
  file:       string
  agentId:    string
  beadId:     string
  reservedAt: string
}

// ── Agent registry types ───────────────────────────────────────────────────

export type AgentPhase =
  | 'idle' | 'routing' | 'claiming' | 'executing'
  | 'reviewing' | 'closing' | 'planning' | 'encoding' | 'waiting'

export interface AgentState {
  id:            string
  index:         number   // 0-based, used for terminal tab ordering
  phase:         AgentPhase
  currentBeadId: string | null
  loopCount:     number
  lastActivity:  string
}

// ── Mail message types ─────────────────────────────────────────────────────

export type MailType = 'claimed' | 'completed' | 'failed' | 'started' | 'stopped' | 'info'

export interface MailMessage {
  ts:      string
  from:    string   // agentId
  type:    MailType
  beadId?: string
  files?:  string[]
  text?:   string
}

// ── AgentCoordinator ───────────────────────────────────────────────────────

export class AgentCoordinator {
  private readonly lockFile:    string  // .ralph/file_locks.json
  private readonly agentsFile:  string  // .ralph/agents.json
  private readonly mailFile:    string  // .ralph/agent_mail.jsonl

  constructor(private readonly ralphDir: string) {
    this.lockFile   = join(ralphDir, 'file_locks.json')
    this.agentsFile = join(ralphDir, 'agents.json')
    this.mailFile   = join(ralphDir, 'agent_mail.jsonl')
    mkdirSync(ralphDir, { recursive: true })
  }

  // ── File locks ───────────────────────────────────────────────────────────

  private readLocks(): FileReservation[] {
    if (!existsSync(this.lockFile)) return []
    try { return JSON.parse(readFileSync(this.lockFile, 'utf8')) as FileReservation[] }
    catch { return [] }
  }

  private writeLocks(locks: FileReservation[]): void {
    writeFileSync(this.lockFile, JSON.stringify(locks, null, 2))
  }

  reserveFiles(agentId: string, beadId: string, files: string[]): void {
    const locks = this.readLocks().filter(
      l => !(l.agentId === agentId && l.beadId === beadId)
    )
    const now = new Date().toISOString()
    for (const file of files) {
      locks.push({ file, agentId, beadId, reservedAt: now })
    }
    this.writeLocks(locks)
  }

  releaseFiles(agentId: string, beadId: string): void {
    const locks = this.readLocks().filter(
      l => !(l.agentId === agentId && l.beadId === beadId)
    )
    this.writeLocks(locks)
  }

  releaseAllForAgent(agentId: string): void {
    this.writeLocks(this.readLocks().filter(l => l.agentId !== agentId))
  }

  /** Returns files from `candidates` that are locked by a *different* agent. */
  conflictingFiles(agentId: string, candidates: string[]): string[] {
    const locks = this.readLocks()
    return candidates.filter(f =>
      locks.some(l => l.file === f && l.agentId !== agentId)
    )
  }

  /** True if every file in the bead's list is free (or owned by this agent). */
  filesAvailable(agentId: string, files: string[]): boolean {
    return this.conflictingFiles(agentId, files).length === 0
  }

  // ── Agent registry ───────────────────────────────────────────────────────

  private readAgents(): AgentState[] {
    if (!existsSync(this.agentsFile)) return []
    try { return JSON.parse(readFileSync(this.agentsFile, 'utf8')) as AgentState[] }
    catch { return [] }
  }

  private writeAgents(agents: AgentState[]): void {
    writeFileSync(this.agentsFile, JSON.stringify(agents, null, 2))
  }

  registerAgent(agent: AgentState): void {
    const agents = this.readAgents().filter(a => a.id !== agent.id)
    agents.push(agent)
    this.writeAgents(agents)
  }

  updateAgent(id: string, patch: Partial<AgentState>): void {
    const agents = this.readAgents()
    const idx = agents.findIndex(a => a.id === id)
    if (idx < 0) return
    agents[idx] = { ...agents[idx], ...patch, lastActivity: new Date().toISOString() }
    this.writeAgents(agents)
  }

  deregisterAgent(id: string): void {
    this.writeAgents(this.readAgents().filter(a => a.id !== id))
    this.releaseAllForAgent(id)
  }

  getAgents(): AgentState[] {
    return this.readAgents()
  }

  // ── Agent mail ───────────────────────────────────────────────────────────

  post(msg: Omit<MailMessage, 'ts'>): void {
    const full: MailMessage = { ts: new Date().toISOString(), ...msg }
    appendFileSync(this.mailFile, JSON.stringify(full) + '\n')
  }

  /** Read the last N messages from the mail log. */
  readMail(limit = 50): MailMessage[] {
    if (!existsSync(this.mailFile)) return []
    try {
      return readFileSync(this.mailFile, 'utf8')
        .split('\n')
        .filter(Boolean)
        .slice(-limit)
        .map(l => JSON.parse(l) as MailMessage)
    } catch { return [] }
  }

  // ── Bead claim / complete / fail (via bd CLI) ────────────────────────────

  private get projectPath(): string { return dirname(this.ralphDir) }

  /**
   * Atomically claim the best available open bead via `bd`.
   * Returns the claimed bead, or null if nothing is available.
   */
  claimBestBead(agentId: string): Bead | null {
    let beads: Record<string, unknown>[]
    try {
      const { stdout, ok } = bdRun(['list', '--status', 'open', '--json'], this.projectPath)
      if (!ok) return null
      const parsed = JSON.parse(stdout)
      beads = Array.isArray(parsed) ? parsed as Record<string, unknown>[] : []
    } catch { return null }

    if (beads.length === 0) return null

    // Sort by priority descending (bd: 4=highest)
    beads.sort((a, b) => (Number(b['priority'] ?? 0)) - (Number(a['priority'] ?? 0)))

    for (const raw of beads) {
      const id = String(raw['id'] ?? '')
      if (!id) continue
      const files = parseBeadFiles(raw)
      if (!this.filesAvailable(agentId, files)) continue

      // Atomic claim via bd update --claim
      const { ok } = bdRun(['update', id, '--claim'], this.projectPath)
      if (!ok) continue

      this.reserveFiles(agentId, id, files)
      this.post({ from: agentId, type: 'claimed', beadId: id, files })
      return mapBdBead(raw, files)
    }
    return null
  }

  completeBead(agentId: string, beadId: string): string[] {
    bdRun(['close', beadId, '--reason', 'Done'], this.projectPath)
    this.releaseFiles(agentId, beadId)
    this.post({ from: agentId, type: 'completed', beadId })
    return []
  }

  failBead(agentId: string, beadId: string, reason: string): void {
    bdRun(['close', beadId, '--reason', `Failed: ${reason.slice(0, 200)}`], this.projectPath)
    this.releaseFiles(agentId, beadId)
    this.post({ from: agentId, type: 'failed', beadId, text: reason })
  }

  /** Returns last N closed beads as { stdout, ok } for sibling context. */
  bdListClosed(limit = 5): { stdout: string; ok: boolean } {
    return bdRun(['list', '--status', 'closed', '--json'], this.projectPath)
  }

  /** True if there are any open or in-progress beads. */
  hasOpenWork(): boolean {
    try {
      const open = JSON.parse(bdRun(['list', '--status', 'open', '--json'], this.projectPath).stdout)
      if (Array.isArray(open) && open.length > 0) return true
      const claimed = JSON.parse(bdRun(['list', '--status', 'in_progress', '--json'], this.projectPath).stdout)
      return Array.isArray(claimed) && claimed.length > 0
    } catch { return false }
  }

  // ── Graph helpers ─────────────────────────────────────────────────────────

  loadGraph(): BeadGraph | null {
    return loadGraph(this.ralphDir)
  }
}
