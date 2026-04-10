/**
 * IPC data-shape types for the renderer process.
 *
 * ⚠️  KEEP IN SYNC with src/main/types.ts
 * These mirror the main-process types so the renderer can use concrete types
 * instead of `any`. When you change a type in main/types.ts, update it here too.
 */

// ---------------------------------------------------------------------------
// Bead types
// ---------------------------------------------------------------------------

export type BeadStatus = 'pending' | 'ready' | 'claimed' | 'done' | 'failed'
export type BeadType = 'epic' | 'task' | 'subtask'

export interface Bead {
  id: string
  title: string
  description: string
  type: BeadType
  status: BeadStatus
  deps: string[]
  files: string[]
  priority: number
  tags: string[]
  createdAt?: string
  claimedBy?: string
  claimedAt?: string
  completedAt?: string
  failedAt?: string
  epicId?: string
  taskId?: string
  commentCount?: number
}

// ---------------------------------------------------------------------------
// File lock types
// ---------------------------------------------------------------------------

export interface FileLock {
  file: string
  agentId: string
  beadId: string
  reservedAt: string
}

// ---------------------------------------------------------------------------
// Agent types
// ---------------------------------------------------------------------------

export type AgentPhase =
  | 'idle'
  | 'routing'
  | 'waiting'
  | 'claiming'
  | 'thinking'
  | 'executing'
  | 'reviewing'
  | 'merging'
  | 'closing'
  | 'paused'

export type SwarmPhase =
  | 'idle'
  | 'starting'
  | 'health-check'
  | 'spawning-workers'
  | 'ready'
  | 'stopping'
  | 'stopped'

export interface AgentInfo {
  id: string
  index: number
  phase: AgentPhase | string
  currentBeadId: string | null
  currentBeadTitle: string | null
  currentBeadDescription: string | null
  currentBeadType: BeadType | null
  loopCount: number
  lastActivity: string
  worktreeBranch: string | null
  thinkingSummary: string | null
}

// ---------------------------------------------------------------------------
// Activity & knowledge
// ---------------------------------------------------------------------------

export interface ActivityEvent {
  ts: string
  agentId: string
  type:
    | 'started'
    | 'thinking'
    | 'claimed'
    | 'executing'
    | 'merged'
    | 'completed'
    | 'failed'
    | 'stopped'
    | 'paused'
    | 'resumed'
    | 'rollback'
    | 'split'
    | 'circuit_open'
    | 'circuit_closed'
  beadId?: string
  beadTitle?: string
  summary?: string
  filesChanged?: string[]
  branch?: string
  commitSha?: string
}

export type KnowledgeCategory = 'pattern' | 'gotcha' | 'dependency' | 'convention' | 'environment' | 'risk'
export type KnowledgeConfidence = 'high' | 'medium' | 'low'

export interface KnowledgeEntry {
  ts: string
  agentId: string
  beadId: string
  category: KnowledgeCategory
  summary: string
  detail: string
  confidence: KnowledgeConfidence
}

// ---------------------------------------------------------------------------
// Mail
// ---------------------------------------------------------------------------

export interface MailMessage {
  ts: string
  from: string
  to: string
  subject: string
  body: string
  threadId: string
  read: boolean
  beadId?: string
}

// ---------------------------------------------------------------------------
// Circuit breaker
// ---------------------------------------------------------------------------

export interface CircuitBreakerSnapshot {
  state: 'CLOSED' | 'HALF_OPEN' | 'OPEN'
  last_change: string
  consecutive_no_progress: number
  consecutive_same_error: number
  error_window_count: number
  consecutive_permission_denials: number
  last_progress_loop: number
  total_opens: number
  reason: string
  current_loop: number
  opened_at?: string
  reopen_epoch: number
  rate_limit_until?: string
  agentId?: string
}

// ---------------------------------------------------------------------------
// Swarm status (implicit return type from swarm:status IPC handler)
// ---------------------------------------------------------------------------

export interface SwarmStatus {
  running: boolean
  planning: boolean
  planRequest: string | null
  workerCount: number
  agents: AgentInfo[]
  stats: ProgressStats | null
  sessionStartedAt: string | null
  stoppingGracefully: boolean
  swarmPhase: SwarmPhase
}

// ---------------------------------------------------------------------------
// Progress / bead stats
// ---------------------------------------------------------------------------

export interface ProgressStats {
  total: number
  pending: number
  ready: number
  claimed: number
  done: number
  failed: number
  pct: number
}

// ---------------------------------------------------------------------------
// Plan queue
// ---------------------------------------------------------------------------

export interface PlanQueueItem {
  id: string
  request: string
}

// ---------------------------------------------------------------------------
// Auto-update types
// ---------------------------------------------------------------------------

export type UpdateState =
  | 'idle'
  | 'checking'
  | 'available'
  | 'not-available'
  | 'downloading'
  | 'downloaded'
  | 'error'

export interface UpdateInfo {
  version: string
  releaseDate: string
  releaseNotes: string | null
}

export interface UpdateProgress {
  percent: number
  bytesPerSecond: number
  transferred: number
  total: number
}

export type UpdateEvent =
  | { type: 'checking' }
  | { type: 'available'; info: UpdateInfo }
  | { type: 'not-available'; info: UpdateInfo }
  | { type: 'progress'; progress: UpdateProgress }
  | { type: 'downloaded'; info: UpdateInfo }
  | { type: 'error'; error: string }

// ---------------------------------------------------------------------------
// bd memories & comments
// ---------------------------------------------------------------------------

/**
 * Raw output of `bd memories --json`: a flat map of key → text.
 * Parse into BdMemory[] for typed use.
 */
export type BdMemoriesMap = Record<string, string>

/** A single memory entry, normalised from a BdMemoriesMap entry. */
export interface BdMemory {
  key: string
  text: string
  /** ISO timestamp of when this memory was created (tracked by the app). */
  createdAt?: string
}

/** Result of `bd remember --json`. */
export interface BdRememberResult {
  action: string
  key: string
  value: string
}

/** Result of `bd forget --json`. */
export interface BdForgetResult {
  deleted: string
  key: string
}

/** A comment on a bead, as returned by `bd comments <id> --json`. */
export interface BdComment {
  id: string
  issueId: string
  author: string
  text: string
  createdAt: string
}

// ---------------------------------------------------------------------------
// Config types (structured .slashbotrc)
// ---------------------------------------------------------------------------

export type TelegramNotifyLevel = 'all' | 'errors' | 'completions' | 'none'

export interface TelegramConfig {
  botToken: string
  chatId: string
  enabled: boolean
  notifyOn: TelegramNotifyLevel
}

export interface RalphConfig {
  maxCallsPerHour: number
  claudeTimeoutMinutes: number
  claudeOutputFormat: 'json' | 'text'
  claudeCodeCmd: string
  allowedTools: string
  sleepDuration: number
  continueSession: boolean
  cbNoProgressThreshold: number
  cbSameErrorThreshold: number
  cbErrorWindowSize: number
  cbErrorWindowThreshold: number
  cbPermissionDenialThreshold: number
  cbCooldownMinutes: number
  cbMaxCooldownMinutes: number
  autoPush: boolean
  maxRetries: number
  autoSplitThreshold: number
  buildMonitorCmd: string
  buildMonitorInterval: number
  claudeModelThink: string
  claudeModelExecute: string
  claudeModelReview: string
  telegram?: TelegramConfig
}
