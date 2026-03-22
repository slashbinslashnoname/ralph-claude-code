// Shared types for the main process

export type TelegramNotifyLevel = 'all' | 'errors' | 'completions' | 'none'

export interface TelegramConfig {
  botToken: string
  chatId: string
  enabled: boolean
  notifyOn: TelegramNotifyLevel
}

export interface TelegramStatus {
  connected: boolean
  botUsername: string | null
  lastError: string | null
  messagesSent: number
  messagesReceived: number
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
  cbPermissionDenialThreshold: number
  cbCooldownMinutes: number
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

export interface CreateBeadOpts {
  id?: string
  title: string
  type?: BeadType | 'bug' | 'feature'
  priority?: number
  description?: string
  labels?: string[]
  parentId?: string
}

export interface CreateManyResult {
  created: Bead[]
  failed: { opts: CreateBeadOpts; error: string }[]
}

export interface BeadStats {
  total: number
  pending: number
  ready: number
  claimed: number
  done: number
  failed: number
  pct: number
}

export interface FileLock {
  file: string
  agentId: string
  beadId: string
  reservedAt: string
}

export type AgentPhase = 'idle' | 'routing' | 'waiting' | 'claiming' | 'thinking' | 'executing' | 'reviewing' | 'merging' | 'closing' | 'paused'

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

/** Activity event replaces the old mail system */
export interface ActivityEvent {
  ts: string
  agentId: string
  type: 'started' | 'thinking' | 'claimed' | 'executing' | 'merged' | 'completed' | 'failed' | 'stopped' | 'paused' | 'resumed' | 'rollback' | 'split' | 'heartbeat' | 'dead_agent' | 'claim_timeout'
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

export interface LoopStatus {
  timestamp: string
  loop_count: number
  calls_made_this_hour: number
  max_calls_per_hour: number
  last_action: string
  status: string
  exit_reason: string
  next_reset: string
}

export interface AnalysisResult {
  hasCompletionSignal: boolean
  exitSignal: boolean
  workType: string
  filesModified: number
  askingQuestions: boolean
  questionCount: number
  hasPermissionDenials: boolean
  deniedCommands: string[]
  isStuck: boolean
  isTestOnly: boolean
  hasProgress: boolean
  workSummary: string
}

export interface ProjectContext {
  type: string
  name: string
  hasGit: boolean
  hasBeads: boolean
  installCmd: string
  testCmd: string
  buildCmd: string
}

export interface EnableOptions {
  force: boolean
  maxCallsPerHour: number
  useBeads: boolean
  initialTasks: string[]
}

export interface EnableResult {
  ok: boolean
  alreadyEnabled?: boolean
  error?: string
  filesCreated: string[]
  context: ProjectContext
}

export interface SplitChild {
  title: string
  description: string
  files: string[]
  deps: string[]
}

export interface SplitDecision {
  beadId: string
  reason: string
  children: SplitChild[]
}

export interface PlanQueueItem {
  id: string
  request: string
}
