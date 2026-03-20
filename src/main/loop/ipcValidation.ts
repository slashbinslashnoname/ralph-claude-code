/**
 * Generic IPC validation middleware — reusable primitives for validating
 * untrusted renderer input in IPC handlers.
 *
 * Each function throws on invalid input so the IPC try/catch
 * returns { ok: false, error } to the renderer.
 */

import * as path from 'path'

// ── Path validation ──────────────────────────────────────────────────────────

const MAX_PATH_LENGTH = 4096

export interface ValidatePathOptions {
  /** If provided, the resolved path must be inside this directory. */
  containIn?: string
  /** Whether the path must be absolute. Defaults to false. */
  absolute?: boolean
  /** Custom field name for error messages. Defaults to 'path'. */
  field?: string
  /** Max allowed length. Defaults to 4096. */
  maxLength?: number
}

/**
 * Validates a filesystem path: rejects traversal, null bytes, and
 * optionally enforces containment within a directory.
 */
export function validatePath(value: unknown, opts: ValidatePathOptions = {}): string {
  const field = opts.field ?? 'path'
  const maxLength = opts.maxLength ?? MAX_PATH_LENGTH

  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${field} must be a non-empty string`)
  }
  if (value.length > maxLength) {
    throw new Error(`${field} must be ${maxLength} characters or fewer`)
  }
  if (value.includes('\0')) {
    throw new Error(`${field} must not contain null bytes`)
  }
  if (opts.absolute && !path.isAbsolute(value)) {
    throw new Error(`${field} must be an absolute path`)
  }

  if (opts.containIn) {
    const resolved = path.resolve(opts.containIn, value)
    const container = path.resolve(opts.containIn)
    if (resolved !== container && !resolved.startsWith(container + path.sep)) {
      throw new Error(`${field}: path traversal detected — resolved path is outside allowed directory`)
    }
    return resolved
  }

  return value
}

// ── String validation ────────────────────────────────────────────────────────

export interface ValidateStringOptions {
  /** Minimum length (inclusive). Defaults to 1 (non-empty). */
  minLength?: number
  /** Maximum length (inclusive). Defaults to 1024. */
  maxLength?: number
  /** Regex the value must match. */
  pattern?: RegExp
  /** Custom field name for error messages. Defaults to 'value'. */
  field?: string
  /** If true, trims whitespace before validation. Defaults to false. */
  trim?: boolean
  /** If true, undefined/null returns undefined. Defaults to false (required). */
  optional?: boolean
}

export function validateString(value: unknown, opts: ValidateStringOptions = {}): string
export function validateString(value: unknown, opts: ValidateStringOptions & { optional: true }): string | undefined
export function validateString(value: unknown, opts: ValidateStringOptions = {}): string | undefined {
  const field = opts.field ?? 'value'
  const minLength = opts.minLength ?? 1
  const maxLength = opts.maxLength ?? 1024

  if (value === undefined || value === null) {
    if (opts.optional) return undefined
    throw new Error(`${field} is required`)
  }

  if (typeof value !== 'string') {
    throw new Error(`${field} must be a string`)
  }

  let s = value
  if (opts.trim) {
    s = s.trim()
  }

  if (s.length < minLength) {
    throw new Error(`${field} must be at least ${minLength} character(s)`)
  }
  if (s.length > maxLength) {
    throw new Error(`${field} must be ${maxLength} characters or fewer`)
  }
  if (opts.pattern && !opts.pattern.test(s)) {
    throw new Error(`${field} contains invalid characters`)
  }

  return s
}

// ── Number validation ────────────────────────────────────────────────────────

export interface ValidateNumberOptions {
  /** Minimum value (inclusive). */
  min?: number
  /** Maximum value (inclusive). */
  max?: number
  /** Whether the value must be an integer. Defaults to true. */
  integer?: boolean
  /** Custom field name for error messages. Defaults to 'value'. */
  field?: string
  /** If true, undefined/null returns undefined. Defaults to false (required). */
  optional?: boolean
  /** Default value when optional and input is undefined/null. */
  defaultValue?: number
}

export function validateNumber(value: unknown, opts: ValidateNumberOptions = {}): number
export function validateNumber(value: unknown, opts: ValidateNumberOptions & { optional: true }): number | undefined
export function validateNumber(value: unknown, opts: ValidateNumberOptions = {}): number | undefined {
  const field = opts.field ?? 'value'
  const integer = opts.integer ?? true

  if (value === undefined || value === null) {
    if (opts.defaultValue !== undefined) return opts.defaultValue
    if (opts.optional) return undefined
    throw new Error(`${field} is required`)
  }

  const n = typeof value === 'string' ? Number(value) : value
  if (typeof n !== 'number' || Number.isNaN(n)) {
    throw new Error(`${field} must be a number`)
  }
  if (integer && !Number.isInteger(n)) {
    throw new Error(`${field} must be an integer`)
  }
  if (opts.min !== undefined && n < opts.min) {
    throw new Error(`${field} must be at least ${opts.min}`)
  }
  if (opts.max !== undefined && n > opts.max) {
    throw new Error(`${field} must be at most ${opts.max}`)
  }

  return n
}

// ── Enum validation ──────────────────────────────────────────────────────────

export interface ValidateEnumOptions {
  /** Custom field name for error messages. Defaults to 'value'. */
  field?: string
  /** If true, undefined/null returns undefined. Defaults to false (required). */
  optional?: boolean
  /** If true, normalizes input with trim + lowercase before matching. Defaults to false. */
  normalize?: boolean
  /** Default value when optional and input is undefined/null. */
  defaultValue?: string
}

export function validateEnum(value: unknown, allowed: readonly string[], opts: ValidateEnumOptions = {}): string
export function validateEnum(value: unknown, allowed: readonly string[], opts: ValidateEnumOptions & { optional: true }): string | undefined
export function validateEnum(value: unknown, allowed: readonly string[], opts: ValidateEnumOptions = {}): string | undefined {
  const field = opts.field ?? 'value'

  if (value === undefined || value === null) {
    if (opts.defaultValue !== undefined) return opts.defaultValue
    if (opts.optional) return undefined
    throw new Error(`${field} is required`)
  }

  if (typeof value !== 'string') {
    throw new Error(`${field} must be a string`)
  }

  let s = value
  if (opts.normalize) {
    s = s.trim().toLowerCase()
  }

  if (!allowed.includes(s)) {
    throw new Error(`${field} must be one of: ${allowed.join(', ')}`)
  }

  return s
}
