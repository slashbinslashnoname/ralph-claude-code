/**
 * Validation helpers for swarm IPC handlers.
 * Pure functions — throw on invalid input so the IPC try/catch
 * returns { ok: false, error } to the renderer.
 */

import { validateProjectPath, validateStatusFilter, validateBeadId } from './beadValidation'

// ── Worker count validation ──────────────────────────────────────────────────
const MIN_WORKERS = 1
const MAX_WORKERS = 8

export function validateWorkerCount(count: unknown): number {
  if (count === undefined || count === null) return 2 // default
  const n = typeof count === 'string' ? Number(count) : count
  if (typeof n !== 'number' || !Number.isInteger(n)) {
    throw new Error('workerCount must be an integer')
  }
  if (n < MIN_WORKERS || n > MAX_WORKERS) {
    throw new Error(`workerCount must be between ${MIN_WORKERS} and ${MAX_WORKERS}`)
  }
  return n
}

// ── Plan request validation ──────────────────────────────────────────────────
const MAX_PLAN_LENGTH = 50_000

export function validatePlanRequest(request: unknown): string {
  if (typeof request !== 'string' || request.trim().length === 0) {
    throw new Error('plan request must be a non-empty string')
  }
  if (request.length > MAX_PLAN_LENGTH) {
    throw new Error(`plan request must be ${MAX_PLAN_LENGTH} characters or fewer`)
  }
  return request
}

// ── Agent ID validation ──────────────────────────────────────────────────────
// Agent IDs follow the pattern worker-{beadId} (e.g., worker-ralph-claude-code-fhv)
// or worker-N for idle workers (e.g., worker-0, worker-1).
// Bead IDs are lowercase alphanumeric with hyphens, 1–61 characters.
const AGENT_ID_RE = /^worker-[a-zA-Z0-9]([a-zA-Z0-9-]{0,59}[a-zA-Z0-9])?$/

export function validateAgentId(agentId: unknown): string {
  if (typeof agentId !== 'string' || agentId.length === 0) {
    throw new Error('agentId must be a non-empty string')
  }
  if (!AGENT_ID_RE.test(agentId)) {
    throw new Error(
      'agentId must match pattern "worker-{id}" (e.g., worker-0, worker-ralph-claude-code-fhv)'
    )
  }
  return agentId
}

// ── Activity limit validation ────────────────────────────────────────────────
const MAX_ACTIVITY_LIMIT = 1000

export function validateActivityLimit(limit: unknown): number {
  if (limit === undefined || limit === null) return 50 // default
  const n = typeof limit === 'string' ? Number(limit) : limit
  if (typeof n !== 'number' || !Number.isInteger(n)) {
    throw new Error('limit must be an integer')
  }
  if (n < 1 || n > MAX_ACTIVITY_LIMIT) {
    throw new Error(`limit must be between 1 and ${MAX_ACTIVITY_LIMIT}`)
  }
  return n
}

// ── Log filename validation ──────────────────────────────────────────────────
// Log filenames match: worker-{id}_{phase}_{timestamp}.log
const LOG_FILENAME_RE = /^worker-[a-zA-Z0-9][a-zA-Z0-9-]{0,59}[a-zA-Z0-9]?_(think|execute|review)_[\w-]+\.log$/

export function validateLogFilename(filename: unknown): string {
  if (typeof filename !== 'string' || filename.length === 0) {
    throw new Error('filename must be a non-empty string')
  }
  if (filename.includes('/') || filename.includes('..') || filename.includes('\\')) {
    throw new Error('filename must not contain path separators or traversal sequences')
  }
  if (!LOG_FILENAME_RE.test(filename)) {
    throw new Error('filename must match worker log format (e.g., worker-ralph-code-fhv_think_2024-01-01.log)')
  }
  return filename
}

// ── Queue ID validation ──────────────────────────────────────────────────────
// Queue IDs are generated with crypto.randomUUID() style or similar
const QUEUE_ID_RE = /^[a-zA-Z0-9_-]{1,64}$/

export function validateQueueId(id: unknown): string {
  if (typeof id !== 'string' || id.length === 0) {
    throw new Error('queue id must be a non-empty string')
  }
  if (!QUEUE_ID_RE.test(id)) {
    throw new Error('queue id contains invalid characters')
  }
  return id
}

// ── Composite validators for IPC handlers ────────────────────────────────────

export function validateSwarmStart(projectPath: unknown, workerCount: unknown): {
  projectPath: string; workerCount: number
} {
  return {
    projectPath: validateProjectPath(projectPath),
    workerCount: validateWorkerCount(workerCount),
  }
}

export function validateSwarmStop(projectPath: unknown): {
  projectPath: string
} {
  return {
    projectPath: validateProjectPath(projectPath),
  }
}

export function validateSwarmInject(projectPath: unknown, request: unknown): {
  projectPath: string; request: string
} {
  return {
    projectPath: validateProjectPath(projectPath),
    request: validatePlanRequest(request),
  }
}

export function validateSwarmQueueRemove(projectPath: unknown, id: unknown): {
  projectPath: string; id: string
} {
  return {
    projectPath: validateProjectPath(projectPath),
    id: validateQueueId(id),
  }
}

export function validateSwarmActivity(projectPath: unknown, limit: unknown): {
  projectPath: string; limit: number
} {
  return {
    projectPath: validateProjectPath(projectPath),
    limit: validateActivityLimit(limit),
  }
}

export function validateSwarmActivityForBead(projectPath: unknown, beadId: unknown, limit: unknown): {
  projectPath: string; beadId: string; limit: number
} {
  return {
    projectPath: validateProjectPath(projectPath),
    beadId: validateBeadId(beadId, 'beadId'),
    limit: validateActivityLimit(limit),
  }
}

export function validateSwarmActivityForAgent(projectPath: unknown, agentId: unknown, limit: unknown): {
  projectPath: string; agentId: string; limit: number
} {
  return {
    projectPath: validateProjectPath(projectPath),
    agentId: validateAgentId(agentId),
    limit: validateActivityLimit(limit),
  }
}

export function validateSwarmActivityHistory(projectPath: unknown, before: unknown, limit: unknown): {
  projectPath: string; before: string | undefined; limit: number
} {
  let b: string | undefined
  if (before !== undefined && before !== null) {
    if (typeof before !== 'string' || before.length === 0) {
      throw new Error('before must be a non-empty ISO timestamp string')
    }
    b = before
  }
  return {
    projectPath: validateProjectPath(projectPath),
    before: b,
    limit: validateActivityLimit(limit),
  }
}

export function validateSwarmAgentOutput(projectPath: unknown, agentId: unknown): {
  projectPath: string; agentId: string
} {
  return {
    projectPath: validateProjectPath(projectPath),
    agentId: validateAgentId(agentId),
  }
}

export function validateSwarmAgentLogContent(projectPath: unknown, filename: unknown): {
  projectPath: string; filename: string
} {
  return {
    projectPath: validateProjectPath(projectPath),
    filename: validateLogFilename(filename),
  }
}

export function validateSwarmQueue(projectPath: unknown): {
  projectPath: string
} {
  return {
    projectPath: validateProjectPath(projectPath),
  }
}

export function validateSwarmStatus(projectPath: unknown): {
  projectPath: string
} {
  return {
    projectPath: validateProjectPath(projectPath),
  }
}

export function validateSwarmBeads(projectPath: unknown, status: unknown): {
  projectPath: string; status: string
} {
  // Default to 'all' (not 'open') to preserve original swarm:beads behavior
  const s = (status === undefined || status === null) ? 'all' : validateStatusFilter(status)
  return {
    projectPath: validateProjectPath(projectPath),
    status: s,
  }
}

export function validateSwarmBeadStats(projectPath: unknown): {
  projectPath: string
} {
  return {
    projectPath: validateProjectPath(projectPath),
  }
}

export function validateSwarmAgentLogs(projectPath: unknown): {
  projectPath: string
} {
  return {
    projectPath: validateProjectPath(projectPath),
  }
}

export function validateSwarmPauseResume(projectPath: unknown, agentId: unknown): {
  projectPath: string; agentId: string
} {
  return {
    projectPath: validateProjectPath(projectPath),
    agentId: validateAgentId(agentId),
  }
}

export function validateSwarmKnowledge(projectPath: unknown, limit: unknown): {
  projectPath: string; limit: number
} {
  return {
    projectPath: validateProjectPath(projectPath),
    limit: validateActivityLimit(limit),
  }
}

// ── Build monitor enabled validation ────────────────────────────────────────

export function validateBuildMonitorEnabled(enabled: unknown): boolean {
  if (typeof enabled !== 'boolean') {
    throw new Error('enabled must be a boolean (true or false)')
  }
  return enabled
}

// ── Composite: build monitor toggle ─────────────────────────────────────────

export function validateSwarmBuildMonitorToggle(projectPath: unknown, enabled: unknown): {
  projectPath: string; enabled: boolean
} {
  return {
    projectPath: validateProjectPath(projectPath),
    enabled: validateBuildMonitorEnabled(enabled),
  }
}

// ── Composite: build monitor status ─────────────────────────────────────────

export function validateSwarmBuildMonitorStatus(projectPath: unknown): {
  projectPath: string
} {
  return {
    projectPath: validateProjectPath(projectPath),
  }
}

// ── Composite: plan approve / reject ──────────────────────────────────────

export function validateSwarmPlanApprove(projectPath: unknown, modifiedPlan: unknown): {
  projectPath: string
  modifiedPlan?: string
} {
  const result: { projectPath: string; modifiedPlan?: string } = {
    projectPath: validateProjectPath(projectPath),
  }
  if (modifiedPlan !== undefined && modifiedPlan !== null) {
    if (typeof modifiedPlan !== 'string') throw new Error('modifiedPlan must be a string')
    result.modifiedPlan = modifiedPlan
  }
  return result
}

export function validateSwarmPlanReject(projectPath: unknown): {
  projectPath: string
} {
  return {
    projectPath: validateProjectPath(projectPath),
  }
}
