/// <reference types="vite/client" />

import type {
  Bead, BeadType, ActivityEvent, KnowledgeEntry,
  CircuitBreakerSnapshot, SwarmStatus, ProgressStats, PlanQueueItem,
  RalphConfig, UpdateState, UpdateInfo, UpdateProgress,
} from './types/ipc'

export {}

interface ProjectContext {
  type: string
  name: string
  hasGit: boolean
  hasBeads: boolean
  installCmd: string
  testCmd: string
  buildCmd: string
}

interface EnableOptions {
  force?: boolean
  maxCallsPerHour?: number
  useBeads?: boolean
  initialTasks?: string[]
}

interface EnableResult {
  ok: boolean
  alreadyEnabled?: boolean
  error?: string
  filesCreated: string[]
  context: ProjectContext
  storeDir?: string
}

interface MigrateCheckResult {
  ok: boolean
  didMigrate?: boolean
  storeDir?: string
  error?: string
  migratedFiles?: string[]
  skipped?: string[]
}

interface BuildStatusDetail {
  beadCreated?: boolean
  beadId?: string
  beadTitle?: string
}

interface SlashbotAPI {
  selectProject: () => Promise<string | null>
  recentProjects: () => Promise<string[]>
  addProject: (p: string) => Promise<{ ok: boolean; error?: string }>
  activeProjectTabs: () => Promise<{ paths: string[]; active: number }>
  saveActiveProjectTabs: (tabs: { paths: string[]; active: number }) => Promise<{ ok: boolean; error?: string }>
  isEnabled: (p: string) => Promise<{ enabled: boolean; missing: string[]; hasRalphrc: boolean; hasRalphDir: boolean; context: ProjectContext }>
  enable: (p: string, opts: EnableOptions) => Promise<EnableResult>
  migrateCheck: (p: string) => Promise<MigrateCheckResult>
  readStatus: (p: string) => Promise<{ circuit: CircuitBreakerSnapshot | null; status: unknown; progress: unknown; analysis: unknown }>
  subscribeProject: (p: string) => Promise<void>
  unsubscribeProject: (p: string) => Promise<void>
  onCircuitUpdate: (cb: (proj: string, c: CircuitBreakerSnapshot) => void) => () => void
  onLogLines: (cb: (proj: string, lines: string[]) => void) => () => void
  readLogs: (p: string, lines?: number) => Promise<string[]>
  listLogs: (p: string) => Promise<string[]>
  readFile: (p: string, rel: string) => Promise<{ ok: boolean; content?: string; error?: string }>
  writeFile: (p: string, rel: string, c: string) => Promise<{ ok: boolean; error?: string }>
  resetCircuit: (p: string) => Promise<{ ok: boolean }>
  resetSession: (p: string) => Promise<{ ok: boolean }>
  beads: {
    check: (p: string) => Promise<{ available: boolean; reason?: string }>
    list: (p: string, filter?: string) => Promise<{ ok: boolean; tasks: Bead[] }>
    show: (p: string, id: string) => Promise<{ ok: boolean; task?: Bead }>
    create: (p: string, opts: { title: string; type?: BeadType; priority?: number; description?: string; labels?: string[]; deps?: string[] }) => Promise<{ ok: boolean; task?: Bead; error?: string }>
    update: (p: string, id: string, opts: { priority?: number; claim?: boolean; unclaim?: boolean; title?: string; description?: string; labelsAdd?: string[]; labelsRemove?: string[] }) => Promise<{ ok: boolean }>
    close: (p: string, id: string, reason?: string) => Promise<{ ok: boolean }>
    reopen: (p: string, id: string, reason?: string) => Promise<{ ok: boolean }>
    rollback: (p: string, id: string, agentId?: string) => Promise<{ ok: boolean; revertedShas?: string[]; error?: string }>
    ready: (p: string) => Promise<{ ok: boolean; tasks: Bead[] }>
    stats: (p: string) => Promise<{ ok: boolean; stats?: ProgressStats; error?: string }>
  }
  swarm: {
    inject: (p: string, req: string) => Promise<{ ok: boolean; id?: string }>
    queueRemove: (p: string, id: string) => Promise<{ ok: boolean }>
    queue: (p: string) => Promise<PlanQueueItem[]>
    start: (p: string, n?: number) => Promise<{ ok: boolean }>
    stop: (p: string) => Promise<{ ok: boolean }>
    gracefulStop: (p: string) => Promise<{ ok: boolean }>
    pauseAgent: (p: string, agentId: string) => Promise<{ ok: boolean }>
    resumeAgent: (p: string, agentId: string) => Promise<{ ok: boolean }>
    pauseAll: (p: string) => Promise<{ ok: boolean }>
    resumeAll: (p: string) => Promise<{ ok: boolean }>
    status: (p: string) => Promise<SwarmStatus>
    beads: (p: string, status?: string) => Promise<Bead[]>
    beadStats: (p: string) => Promise<ProgressStats>
    activity: (p: string, limit?: number) => Promise<ActivityEvent[]>
    activityForBead: (p: string, beadId: string, limit?: number) => Promise<ActivityEvent[]>
    activityForAgent: (p: string, agentId: string, limit?: number) => Promise<ActivityEvent[]>
    knowledge: (p: string, limit?: number) => Promise<KnowledgeEntry[]>
    agentOutput: (p: string, agentId: string) => Promise<string>
    agentLogs: (p: string) => Promise<{ file: string; agentId: string; phase: string; timestamp: string; size: number }[]>
    agentLogContent: (p: string, filename: string) => Promise<string>
    onLog: (cb: (proj: string, line: string) => void) => () => void
    onOutput: (cb: (proj: string, agentId: string, chunk: string) => void) => () => void
    onGraph: (cb: (proj: string, stats: ProgressStats) => void) => () => void
    onAgents: (cb: (proj: string, agents: import('./types/ipc').AgentInfo[]) => void) => () => void
    onActivity: (cb: (proj: string, event: ActivityEvent) => void) => () => void
    onPlanPhase: (cb: (proj: string, phase: string, request?: string) => void) => () => void
    onPlanQueue: (cb: (proj: string, queue: PlanQueueItem[]) => void) => () => void
    onStopped: (cb: () => void) => () => void
    buildMonitor: {
      toggle: (p: string, enabled: boolean) => Promise<{ ok: boolean; enabled: boolean; running: boolean; error?: string }>
      status: (p: string) => Promise<{ enabled: boolean; running: boolean; lastStatus?: string; error?: string }>
    }
    onBuildStatus: (cb: (proj: string, status: string, detail?: BuildStatusDetail) => void) => () => void
  }
  telegram: {
    status: (p: string) => Promise<{
      connected: boolean
      botUsername: string | null
      lastError: string | null
      messagesSent: number
      messagesReceived: number
    }>
    configure: (p: string, config: unknown) => Promise<{ ok: boolean; error?: string }>
    test: (p: string) => Promise<{ ok: boolean; error?: string }>
    disconnect: (p: string) => Promise<{ ok: boolean; error?: string }>
  }
  config: {
    read: (p: string) => Promise<{ ok: boolean; config?: RalphConfig; error?: string }>
    write: (p: string, updates: Partial<RalphConfig>) => Promise<{ ok: boolean; error?: string }>
  }
  update: {
    check: () => Promise<void>
    download: () => Promise<void>
    install: () => Promise<void>
    getState: () => Promise<{ state: UpdateState; info?: UpdateInfo; progress?: UpdateProgress; error?: string } | null>
    onChecking: (cb: () => void) => () => void
    onAvailable: (cb: (info: UpdateInfo) => void) => () => void
    onNotAvailable: (cb: () => void) => () => void
    onProgress: (cb: (progress: UpdateProgress) => void) => () => void
    onDownloaded: (cb: (info: UpdateInfo) => void) => () => void
    onError: (cb: (error: string) => void) => () => void
  }
  shell: { openExternal: (url: string) => Promise<void> }
  cleanup: (p?: string) => Promise<void>
}

declare global {
  interface Window {
    slashbot: SlashbotAPI
  }
}
