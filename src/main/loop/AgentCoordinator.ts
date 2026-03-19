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
import { join } from 'path'
import {
  Bead, BeadGraph, loadGraph, saveGraph,
  markClaimed, markDone, markFailed, rankBeads,
  readyBeads, computeUnblockCounts
} from './Bead'

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

  // ── Bead claim / complete / fail ─────────────────────────────────────────

  /**
   * Atomically claim the best available bead for this agent.
   * Returns the claimed bead, or null if nothing is available.
   *
   * "Available" means: status ready, no file conflicts with other agents.
   */
  claimBestBead(agentId: string): Bead | null {
    // Re-read graph fresh each time to see other agents' claims
    const graph = loadGraph(this.ralphDir)
    if (!graph) return null

    const ready = readyBeads(graph)
    if (ready.length === 0) return null

    const unblockCounts = computeUnblockCounts(graph)
    const ranked        = rankBeads(ready, unblockCounts)

    for (const candidate of ranked) {
      if (!this.filesAvailable(agentId, candidate.files)) continue
      // Attempt to claim
      if (!markClaimed(graph, candidate.id, agentId)) continue
      saveGraph(this.ralphDir, graph)
      this.reserveFiles(agentId, candidate.id, candidate.files)
      this.post({ from: agentId, type: 'claimed', beadId: candidate.id, files: candidate.files })
      return graph.beads.find(b => b.id === candidate.id)!
    }
    return null
  }

  completeBead(agentId: string, beadId: string): string[] {
    const graph = loadGraph(this.ralphDir)
    if (!graph) return []
    const unlocked = markDone(graph, beadId)
    saveGraph(this.ralphDir, graph)
    this.releaseFiles(agentId, beadId)
    this.post({ from: agentId, type: 'completed', beadId, text: `unlocked ${unlocked.length} beads` })
    return unlocked
  }

  failBead(agentId: string, beadId: string, reason: string): void {
    const graph = loadGraph(this.ralphDir)
    if (!graph) return
    markFailed(graph, beadId)
    saveGraph(this.ralphDir, graph)
    this.releaseFiles(agentId, beadId)
    this.post({ from: agentId, type: 'failed', beadId, text: reason })
  }

  // ── Graph helpers ─────────────────────────────────────────────────────────

  loadGraph(): BeadGraph | null {
    return loadGraph(this.ralphDir)
  }

  saveGraph(graph: BeadGraph): void {
    saveGraph(this.ralphDir, graph)
  }
}
