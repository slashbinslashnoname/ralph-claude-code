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

export interface AgentInfo {
  id: string
  index: number
  phase: AgentPhase | string
  currentBeadId: string | null
  currentBeadTitle: string | null
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
// Circuit breaker
// ---------------------------------------------------------------------------

export interface CircuitBreakerSnapshot {
  state: 'CLOSED' | 'HALF_OPEN' | 'OPEN'
  last_change: string
  consecutive_no_progress: number
  consecutive_same_error: number
  consecutive_permission_denials: number
  last_progress_loop: number
  total_opens: number
  reason: string
  current_loop: number
  opened_at?: string
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
