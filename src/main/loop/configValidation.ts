/**
 * Validation helpers for config file IPC handlers (file:read, file:write).
 * Pure functions — throw on invalid input so the IPC try/catch
 * returns { ok: false, error } to the renderer.
 */

import * as path from 'path'

// ── Allowlist ────────────────────────────────────────────────────────────────
const EDITABLE_FILES = new Set(['.ralphrc', '.ralph/PROMPT.md', '.ralph/AGENT.md'])

// ── Content limits ───────────────────────────────────────────────────────────
const MAX_CONTENT_LENGTH = 1_000_000 // 1 MB

// ── Relative path validation ─────────────────────────────────────────────────

export function validateRelPath(relPath: unknown): string {
  if (typeof relPath !== 'string' || relPath.length === 0) {
    throw new Error('relPath must be a non-empty string')
  }
  if (!EDITABLE_FILES.has(relPath)) {
    throw new Error(`Not an editable file. Allowed: ${[...EDITABLE_FILES].join(', ')}`)
  }
  return relPath
}

// ── Path containment check ───────────────────────────────────────────────────

export function validateContainment(projectPath: string, relPath: string): string {
  const resolved = path.resolve(projectPath, relPath)
  const resolvedProject = path.resolve(projectPath)
  if (!resolved.startsWith(resolvedProject + path.sep) && resolved !== resolvedProject) {
    throw new Error('Path traversal detected: resolved path is outside project directory')
  }
  return resolved
}

// ── Content validation ───────────────────────────────────────────────────────

export function validateContent(content: unknown): string {
  if (typeof content !== 'string') {
    throw new Error('content must be a string')
  }
  if (content.length > MAX_CONTENT_LENGTH) {
    throw new Error(`content must be ${MAX_CONTENT_LENGTH} characters or fewer`)
  }
  return content
}

// ── Project path validation (reuse from beadValidation pattern) ──────────────

export function validateConfigProjectPath(projectPath: unknown): string {
  if (typeof projectPath !== 'string' || projectPath.trim().length === 0) {
    throw new Error('projectPath must be a non-empty string')
  }
  if (projectPath.includes('\0')) {
    throw new Error('projectPath must not contain null bytes')
  }
  return projectPath
}

// ── Composite validators for IPC handlers ────────────────────────────────────

export function validateConfigRead(projectPath: unknown, relPath: unknown): {
  projectPath: string; relPath: string; resolvedPath: string
} {
  const p = validateConfigProjectPath(projectPath)
  const r = validateRelPath(relPath)
  const resolved = validateContainment(p, r)
  return { projectPath: p, relPath: r, resolvedPath: resolved }
}

export function validateConfigWrite(projectPath: unknown, relPath: unknown, content: unknown): {
  projectPath: string; relPath: string; resolvedPath: string; content: string
} {
  const p = validateConfigProjectPath(projectPath)
  const r = validateRelPath(relPath)
  const resolved = validateContainment(p, r)
  const c = validateContent(content)
  return { projectPath: p, relPath: r, resolvedPath: resolved, content: c }
}
