/**
 * Bead.ts — core bead data model and graph operations.
 *
 * A bead is a self-contained unit of work. Beads form a dependency graph:
 * a bead is "ready" when all its dependency beads are done.
 *
 * Hierarchy: epic > task > subtask
 * Status flow: pending → ready → claimed → done | failed
 */

import { readFileSync, writeFileSync, existsSync } from 'fs'
import { join } from 'path'

export type BeadType   = 'epic' | 'task' | 'subtask'
export type BeadStatus = 'pending' | 'ready' | 'claimed' | 'done' | 'failed'

export interface Bead {
  id:           string
  title:        string
  description:  string
  type:         BeadType
  status:       BeadStatus
  deps:         string[]   // bead IDs that must be done first
  files:        string[]   // files this bead will touch (for conflict detection)
  priority:     number     // 1–10, higher = more important
  epicId?:      string     // parent epic id
  taskId?:      string     // parent task id (subtasks only)
  tags:         string[]
  // assigned by coordinator
  claimedBy?:   string     // agentId
  claimedAt?:   string     // ISO timestamp
  completedAt?: string
  failedAt?:    string
  // computed by router — not persisted
  unblockCount?: number    // beads that become ready when this completes
  score?:        number    // composite routing score
}

export interface BeadGraph {
  version:   number
  createdAt: string
  updatedAt: string
  planMd:    string        // raw markdown plan used to generate these beads
  beads:     Bead[]
}

// ── Persistence ────────────────────────────────────────────────────────────

export function graphPath(ralphDir: string): string {
  return join(ralphDir, 'beads.json')
}

export function loadGraph(ralphDir: string): BeadGraph | null {
  const p = graphPath(ralphDir)
  if (!existsSync(p)) return null
  try {
    return JSON.parse(readFileSync(p, 'utf8')) as BeadGraph
  } catch {
    return null
  }
}

export function saveGraph(ralphDir: string, graph: BeadGraph): void {
  graph.updatedAt = new Date().toISOString()
  writeFileSync(graphPath(ralphDir), JSON.stringify(graph, null, 2))
}

export function initGraph(planMd: string): BeadGraph {
  return {
    version:   1,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    planMd,
    beads:     []
  }
}

// ── Graph Queries ──────────────────────────────────────────────────────────

/** Beads whose every dependency is done. */
export function readyBeads(graph: BeadGraph): Bead[] {
  const doneIds = new Set(graph.beads.filter(b => b.status === 'done').map(b => b.id))
  return graph.beads.filter(b => {
    if (b.status !== 'pending' && b.status !== 'ready') return false
    return b.deps.every(d => doneIds.has(d))
  })
}

/** For each bead, count how many other beads it directly unblocks when completed. */
export function computeUnblockCounts(graph: BeadGraph): Map<string, number> {
  const counts = new Map<string, number>()
  for (const bead of graph.beads) {
    if (bead.status === 'done') continue
    // beads that list this bead as a dep
    const blocked = graph.beads.filter(b => b.deps.includes(bead.id) && b.status === 'pending')
    counts.set(bead.id, blocked.length)
  }
  return counts
}

/**
 * Rank ready beads by composite score:
 *   score = unblockCount * 10 + priority + typeBonus
 * epics > tasks > subtasks get a small bonus so higher-level items run first.
 */
export function rankBeads(beads: Bead[], unblockCounts: Map<string, number>): Bead[] {
  const typeBonus: Record<BeadType, number> = { epic: 3, task: 1, subtask: 0 }
  return beads
    .map(b => ({
      ...b,
      unblockCount: unblockCounts.get(b.id) ?? 0,
      score: (unblockCounts.get(b.id) ?? 0) * 10 + b.priority + typeBonus[b.type]
    }))
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
}

/** Return all beads that would become ready if `beadId` were marked done. */
export function wouldUnlock(graph: BeadGraph, beadId: string): Bead[] {
  const doneIds = new Set(
    graph.beads.filter(b => b.status === 'done' || b.id === beadId).map(b => b.id)
  )
  return graph.beads.filter(b => {
    if (b.status !== 'pending') return false
    if (!b.deps.includes(beadId)) return false
    return b.deps.every(d => doneIds.has(d))
  })
}

/** Stats snapshot for UI. */
export function graphStats(graph: BeadGraph): {
  total: number; pending: number; ready: number
  claimed: number; done: number; failed: number; pct: number
} {
  const counts = { total: 0, pending: 0, ready: 0, claimed: 0, done: 0, failed: 0 }
  for (const b of graph.beads) {
    counts.total++
    counts[b.status]++
  }
  const pct = counts.total ? Math.round((counts.done / counts.total) * 100) : 0
  return { ...counts, pct }
}

/** Upsert a bead by id (replace if exists, append if new). */
export function upsertBead(graph: BeadGraph, bead: Bead): void {
  const idx = graph.beads.findIndex(b => b.id === bead.id)
  if (idx >= 0) graph.beads[idx] = bead
  else graph.beads.push(bead)
}

/** Mark a bead as claimed. Returns false if bead not found or not claimable. */
export function markClaimed(graph: BeadGraph, beadId: string, agentId: string): boolean {
  const bead = graph.beads.find(b => b.id === beadId)
  if (!bead || (bead.status !== 'ready' && bead.status !== 'pending')) return false
  bead.status    = 'claimed'
  bead.claimedBy = agentId
  bead.claimedAt = new Date().toISOString()
  return true
}

/** Mark a bead as done. Returns the IDs that are now unblocked. */
export function markDone(graph: BeadGraph, beadId: string): string[] {
  const bead = graph.beads.find(b => b.id === beadId)
  if (!bead) return []
  const unlocked = wouldUnlock(graph, beadId).map(b => b.id)
  bead.status      = 'done'
  bead.completedAt = new Date().toISOString()
  // Mark newly unblocked beads as ready
  const doneIds = new Set(graph.beads.filter(b => b.status === 'done').map(b => b.id))
  for (const b of graph.beads) {
    if (b.status === 'pending' && b.deps.every(d => doneIds.has(d))) {
      b.status = 'ready'
    }
  }
  return unlocked
}

/** Mark a bead as failed and release it back to ready. */
export function markFailed(graph: BeadGraph, beadId: string): void {
  const bead = graph.beads.find(b => b.id === beadId)
  if (!bead) return
  bead.status   = 'ready'  // make it retryable
  bead.failedAt = new Date().toISOString()
  delete bead.claimedBy
  delete bead.claimedAt
}
