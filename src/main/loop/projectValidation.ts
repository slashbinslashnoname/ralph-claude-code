/**
 * Validation helpers for project IPC handlers.
 * Pure functions — throw on invalid input so the IPC try/catch
 * returns { ok: false, error } to the renderer.
 */

import * as path from 'path'

// ── Constants ────────────────────────────────────────────────────────────────
const MAX_PATH_LENGTH = 1024
const MAX_TABS = 50

// ── Project path validation ─────────────────────────────────────────────────

export function validateProjectPathArg(projectPath: unknown): string {
  if (typeof projectPath !== 'string' || projectPath.length === 0) {
    throw new Error('projectPath must be a non-empty string')
  }
  if (projectPath.length > MAX_PATH_LENGTH) {
    throw new Error(`projectPath must be ${MAX_PATH_LENGTH} characters or fewer`)
  }
  if (projectPath.includes('\0')) {
    throw new Error('projectPath must not contain null bytes')
  }
  if (!path.isAbsolute(projectPath)) {
    throw new Error('projectPath must be an absolute path')
  }
  return projectPath
}

// ── Save-tabs validation ────────────────────────────────────────────────────

export function validateSaveTabs(tabs: unknown): { paths: string[]; active: number } {
  if (!tabs || typeof tabs !== 'object') {
    throw new Error('tabs must be an object')
  }
  const t = tabs as Record<string, unknown>

  if (!Array.isArray(t.paths)) {
    throw new Error('tabs.paths must be an array')
  }
  if (t.paths.length > MAX_TABS) {
    throw new Error(`tabs.paths must have ${MAX_TABS} or fewer entries`)
  }
  const paths: string[] = []
  for (let i = 0; i < t.paths.length; i++) {
    const p = t.paths[i]
    if (typeof p !== 'string' || p.length === 0) {
      throw new Error(`tabs.paths[${i}] must be a non-empty string`)
    }
    if (p.length > MAX_PATH_LENGTH) {
      throw new Error(`tabs.paths[${i}] must be ${MAX_PATH_LENGTH} characters or fewer`)
    }
    if (p.includes('\0')) {
      throw new Error(`tabs.paths[${i}] must not contain null bytes`)
    }
    if (!path.isAbsolute(p)) {
      throw new Error(`tabs.paths[${i}] must be an absolute path`)
    }
    paths.push(p)
  }

  if (typeof t.active !== 'number' || !Number.isInteger(t.active)) {
    throw new Error('tabs.active must be an integer')
  }
  if (t.active < 0) {
    throw new Error('tabs.active must be non-negative')
  }
  const maxActive = paths.length === 0 ? 0 : paths.length - 1
  if (t.active > maxActive) {
    throw new Error(`tabs.active must be at most ${maxActive}`)
  }

  return { paths, active: t.active }
}
