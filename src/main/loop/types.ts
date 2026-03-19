// ── Shared types for the Ralph loop engine ───────────────────────────────────

export type CircuitState = 'CLOSED' | 'HALF_OPEN' | 'OPEN'

export interface CircuitSnapshot {
  state: CircuitState
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

export interface RalphStatus {
  timestamp: string
  loop_count: number
  calls_made_this_hour: number
  max_calls_per_hour: number
  last_action: string
  status: 'running' | 'waiting' | 'completed' | 'halted' | 'error_detected' | 'rate_limited'
  exit_reason: string
  next_reset?: string
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
  sessionId?: string
}

export type ExitReason =
  | 'project_complete'
  | 'plan_complete'
  | 'permission_denied'
  | 'api_limit'
  | 'circuit_open'
  | 'file_integrity'
  | 'stopped'
  | 'error'

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
}

export const DEFAULT_CONFIG: RalphConfig = {
  maxCallsPerHour: 100,
  claudeTimeoutMinutes: 15,
  claudeOutputFormat: 'json',
  claudeCodeCmd: 'claude',
  allowedTools: 'Write,Read,Edit,Bash(git add *),Bash(git commit *),Bash(git status),Bash(git diff),Bash(git log),Bash(npm *),Bash(pytest)',
  sleepDuration: 3,
  continueSession: true,
  cbNoProgressThreshold: 3,
  cbSameErrorThreshold: 5,
  cbPermissionDenialThreshold: 2,
  cbCooldownMinutes: 30
}

// Events emitted by RalphLoop
export interface LoopEvents {
  status:  (s: RalphStatus) => void
  log:     (level: 'INFO' | 'WARN' | 'ERROR' | 'SUCCESS', msg: string) => void
  output:  (chunk: string) => void   // raw Claude output for terminal display
  circuit: (s: CircuitSnapshot) => void
  exit:    (reason: ExitReason, detail?: string) => void
}

// ── Swarm types ────────────────────────────────────────────────────────────

export type AgentPhase =
  | 'idle' | 'routing' | 'claiming' | 'executing'
  | 'reviewing' | 'closing' | 'planning' | 'encoding' | 'waiting'

export interface AgentInfo {
  id:            string
  index:         number
  phase:         AgentPhase
  currentBeadId: string | null
  loopCount:     number
  lastActivity:  string
}

export interface BeadInfo {
  id:           string
  title:        string
  description:  string
  type:         'epic' | 'task' | 'subtask'
  status:       'pending' | 'ready' | 'claimed' | 'done' | 'failed'
  deps:         string[]
  files:        string[]
  priority:     number
  epicId?:      string
  taskId?:      string
  tags:         string[]
  claimedBy?:   string
  claimedAt?:   string
  completedAt?: string
  unblockCount?: number
  score?:        number
}

export interface BeadGraphInfo {
  version:   number
  createdAt: string
  updatedAt: string
  planMd:    string
  beads:     BeadInfo[]
}

export interface SwarmStats {
  total:   number
  pending: number
  ready:   number
  claimed: number
  done:    number
  failed:  number
  pct:     number
}

export interface MailMessageInfo {
  ts:      string
  from:    string
  type:    string
  beadId?: string
  files?:  string[]
  text?:   string
}

export interface SwarmStatus {
  running:     boolean
  planning:    boolean
  workerCount: number
  agents:      AgentInfo[]
  stats:       SwarmStats | null
  planPhase?:  string
}
