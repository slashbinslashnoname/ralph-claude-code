/**
 * Validation helpers for mail IPC handlers.
 * Pure functions — throw on invalid input so the IPC try/catch
 * returns { ok: false, error } to the renderer.
 */

import { validateProjectPath } from './beadValidation'
import { validateActivityLimit } from './swarmValidation'

export function validateMailList(projectPath: unknown, limit: unknown): {
  projectPath: string; limit: number
} {
  return {
    projectPath: validateProjectPath(projectPath),
    limit: validateActivityLimit(limit),
  }
}

export function validateMailSubscribe(projectPath: unknown): {
  projectPath: string
} {
  return {
    projectPath: validateProjectPath(projectPath),
  }
}

export function validateMailUnsubscribe(projectPath: unknown): {
  projectPath: string
} {
  return {
    projectPath: validateProjectPath(projectPath),
  }
}
