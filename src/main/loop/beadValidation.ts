/**
 * Validation helpers for bead IPC handlers.
 * Pure functions — throw on invalid input so the IPC try/catch
 * returns { ok: false, error } to the renderer.
 */

// ── ID validation ─────────────────────────────────────────────────────────────
// bd uses slug-style IDs: alphanumeric, dash, dot, underscore
const BEAD_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/

export function validateBeadId(id: unknown, field = 'id'): string {
  if (typeof id !== 'string' || id.length === 0) {
    throw new Error(`${field} must be a non-empty string`)
  }
  if (!BEAD_ID_RE.test(id)) {
    throw new Error(
      `${field} contains invalid characters (allowed: alphanumeric, dash, dot, underscore; must start with alphanumeric; max 128 chars)`
    )
  }
  return id
}

// ── Status filter validation ──────────────────────────────────────────────────
const VALID_FILTERS = new Set(['open', 'closed', 'in_progress', 'all'])

export function validateStatusFilter(filter: unknown): string {
  if (filter === undefined || filter === null) return 'open'
  if (typeof filter !== 'string') {
    throw new Error('filter must be a string')
  }
  const f = filter.trim().toLowerCase()
  if (!VALID_FILTERS.has(f)) {
    throw new Error(`Invalid filter "${filter}". Must be one of: ${[...VALID_FILTERS].join(', ')}`)
  }
  return f
}

// ── Priority validation ───────────────────────────────────────────────────────
const MIN_PRIORITY = 0
const MAX_PRIORITY = 4

export function validatePriority(priority: unknown, field = 'priority'): number | undefined {
  if (priority === undefined || priority === null) return undefined
  const n = typeof priority === 'string' ? Number(priority) : priority
  if (typeof n !== 'number' || !Number.isInteger(n)) {
    throw new Error(`${field} must be an integer`)
  }
  if (n < MIN_PRIORITY || n > MAX_PRIORITY) {
    throw new Error(`${field} must be between ${MIN_PRIORITY} and ${MAX_PRIORITY}`)
  }
  return n
}

// ── Label validation ──────────────────────────────────────────────────────────
// Labels must not contain commas (they're joined with `,` in BdClient)
// or shell metacharacters that could cause injection
const LABEL_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/

export function validateLabel(label: unknown): string {
  if (typeof label !== 'string' || label.length === 0) {
    throw new Error('Label must be a non-empty string')
  }
  if (!LABEL_RE.test(label)) {
    throw new Error(
      `Label "${label}" is invalid (allowed: alphanumeric, dash, dot, underscore; must start with alphanumeric; max 64 chars)`
    )
  }
  return label
}

export function validateLabels(labels: unknown): string[] | undefined {
  if (labels === undefined || labels === null) return undefined
  if (!Array.isArray(labels)) {
    throw new Error('labels must be an array')
  }
  return labels.map(l => validateLabel(l))
}

// ── Title validation ──────────────────────────────────────────────────────────

export function validateTitle(title: unknown): string {
  if (typeof title !== 'string' || title.trim().length === 0) {
    throw new Error('title must be a non-empty string')
  }
  if (title.length > 512) {
    throw new Error('title must be 512 characters or fewer')
  }
  return title
}

// ── Type validation ───────────────────────────────────────────────────────────
const VALID_TYPES = new Set(['epic', 'task', 'subtask', 'bug', 'feature'])

export function validateBeadType(type: unknown): string | undefined {
  if (type === undefined || type === null) return undefined
  if (typeof type !== 'string') {
    throw new Error('type must be a string')
  }
  if (!VALID_TYPES.has(type)) {
    throw new Error(`Invalid type "${type}". Must be one of: ${[...VALID_TYPES].join(', ')}`)
  }
  return type
}

// ── Description validation ────────────────────────────────────────────────────

export function validateDescription(desc: unknown): string | undefined {
  if (desc === undefined || desc === null) return undefined
  if (typeof desc !== 'string') {
    throw new Error('description must be a string')
  }
  if (desc.length > 10_000) {
    throw new Error('description must be 10000 characters or fewer')
  }
  return desc
}

// ── Project path validation ───────────────────────────────────────────────────

export function validateProjectPath(projectPath: unknown): string {
  if (typeof projectPath !== 'string' || projectPath.trim().length === 0) {
    throw new Error('projectPath must be a non-empty string')
  }
  return projectPath
}

// ── Composite validators for IPC handlers ─────────────────────────────────────

export function validateBeadsList(projectPath: unknown, filter: unknown): {
  projectPath: string; filter: string
} {
  return {
    projectPath: validateProjectPath(projectPath),
    filter: validateStatusFilter(filter),
  }
}

export function validateBeadsCreate(projectPath: unknown, opts: unknown): {
  projectPath: string
  opts: { title: string; type?: string; priority?: number; description?: string; labels?: string[] }
} {
  const p = validateProjectPath(projectPath)
  if (!opts || typeof opts !== 'object') {
    throw new Error('opts must be an object')
  }
  const o = opts as Record<string, unknown>
  return {
    projectPath: p,
    opts: {
      title: validateTitle(o.title),
      type: validateBeadType(o.type),
      priority: validatePriority(o.priority),
      description: validateDescription(o.description),
      labels: validateLabels(o.labels),
    },
  }
}

export function validateBeadsUpdate(projectPath: unknown, id: unknown, opts: unknown): {
  projectPath: string
  id: string
  opts: {
    priority?: number; claim?: boolean; unclaim?: boolean;
    title?: string; description?: string;
    labelsAdd?: string[]; labelsRemove?: string[]
  }
} {
  const p = validateProjectPath(projectPath)
  const beadId = validateBeadId(id)
  if (!opts || typeof opts !== 'object') {
    throw new Error('opts must be an object')
  }
  const o = opts as Record<string, unknown>

  const title = o.title !== undefined ? validateTitle(o.title) : undefined
  const priority = validatePriority(o.priority)
  const description = validateDescription(o.description)
  const labelsAdd = validateLabels(o.labelsAdd)
  const labelsRemove = validateLabels(o.labelsRemove)

  if (o.claim !== undefined && typeof o.claim !== 'boolean') {
    throw new Error('claim must be a boolean')
  }
  if (o.unclaim !== undefined && typeof o.unclaim !== 'boolean') {
    throw new Error('unclaim must be a boolean')
  }

  return {
    projectPath: p,
    id: beadId,
    opts: {
      priority,
      claim: o.claim as boolean | undefined,
      unclaim: o.unclaim as boolean | undefined,
      title,
      description,
      labelsAdd,
      labelsRemove,
    },
  }
}

export function validateBeadsReorder(projectPath: unknown, ids: unknown): {
  projectPath: string; ids: string[]
} {
  const p = validateProjectPath(projectPath)
  if (!Array.isArray(ids)) {
    throw new Error('ids must be an array')
  }
  if (ids.length === 0) {
    throw new Error('ids must not be empty')
  }
  return {
    projectPath: p,
    ids: ids.map((id, i) => validateBeadId(id, `ids[${i}]`)),
  }
}
