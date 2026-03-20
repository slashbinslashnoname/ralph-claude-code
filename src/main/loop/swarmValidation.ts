/**
 * Validation helpers for swarm IPC handlers.
 * Pure functions — throw on invalid input so the IPC try/catch
 * returns { ok: false, error } to the renderer.
 */

import { validateProjectPath } from './beadValidation'

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
// Agent IDs follow the pattern agent-N (e.g., agent-0, agent-1, agent-12)
const AGENT_ID_RE = /^agent-\d{1,3}$/

export function validateAgentId(agentId: unknown): string {
  if (typeof agentId !== 'string' || agentId.length === 0) {
    throw new Error('agentId must be a non-empty string')
  }
  if (!AGENT_ID_RE.test(agentId)) {
    throw new Error(
      'agentId must match pattern "agent-N" (e.g., agent-0, agent-1)'
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
// Log filenames match: agent-N_phase_timestamp.log
const LOG_FILENAME_RE = /^agent-\d{1,3}_(think|execute|review)_[\w-]+\.log$/

export function validateLogFilename(filename: unknown): string {
  if (typeof filename !== 'string' || filename.length === 0) {
    throw new Error('filename must be a non-empty string')
  }
  if (filename.includes('/') || filename.includes('..') || filename.includes('\\')) {
    throw new Error('filename must not contain path separators or traversal sequences')
  }
  if (!LOG_FILENAME_RE.test(filename)) {
    throw new Error('filename must match agent log format (e.g., agent-0_think_2024-01-01.log)')
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
