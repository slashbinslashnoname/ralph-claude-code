/// <reference types="vite/client" />

export {}

interface SlashbotAPI {
  selectProject: () => Promise<string | null>
  recentProjects: () => Promise<string[]>
  addProject: (p: string) => Promise<{ ok: boolean; error?: string }>
  activeProjectTabs: () => Promise<{ paths: string[]; active: number }>
  saveActiveProjectTabs: (tabs: { paths: string[]; active: number }) => Promise<{ ok: boolean; error?: string }>
  isEnabled: (p: string) => Promise<{ enabled: boolean; missing: string[]; context: any }>
  enable: (p: string, opts: any) => Promise<any>
  readStatus: (p: string) => Promise<any>
  subscribeStatus: (p: string) => Promise<void>
  unsubscribeStatus: (p: string) => Promise<void>
  onStatusUpdate: (cb: (...a: any[]) => void) => () => void
  onProgressUpdate: (cb: (...a: any[]) => void) => () => void
  onCircuitUpdate: (cb: (...a: any[]) => void) => () => void
  onAnalysisUpdate: (cb: (...a: any[]) => void) => () => void
  onLogLines: (cb: (...a: any[]) => void) => () => void
  onSlashbotExit: (cb: (...a: any[]) => void) => () => void
  onPtyData: (cb: (...a: any[]) => void) => () => void
  readLogs: (p: string, lines?: number) => Promise<string[]>
  listLogs: (p: string) => Promise<string[]>
  readFile: (p: string, rel: string) => Promise<{ ok: boolean; content?: string; error?: string }>
  writeFile: (p: string, rel: string, c: string) => Promise<{ ok: boolean; error?: string }>
  startSlashbot: (p: string) => Promise<{ ok: boolean; error?: string }>
  stopSlashbot: (p: string) => Promise<void>
  slashbotRunning: (p: string) => Promise<boolean>
  ptyWrite: (p: string, d: string) => Promise<void>
  ptyResize: (c: number, r: number) => Promise<void>
  resetCircuit: (p: string) => Promise<{ ok: boolean }>
  resetSession: (p: string) => Promise<{ ok: boolean }>
  beads: {
    check: (p: string) => Promise<{ available: boolean; reason?: string }>
    list: (p: string, filter?: string) => Promise<{ ok: boolean; tasks: any[] }>
    show: (p: string, id: string) => Promise<{ ok: boolean; task?: any }>
    create: (p: string, opts: any) => Promise<{ ok: boolean; task?: any; error?: string }>
    update: (p: string, id: string, opts: any) => Promise<{ ok: boolean }>
    close: (p: string, id: string, reason?: string) => Promise<{ ok: boolean }>
    reopen: (p: string, id: string, reason?: string) => Promise<{ ok: boolean }>
    rollback: (p: string, id: string, agentId?: string) => Promise<{ ok: boolean; revertedShas?: string[]; error?: string }>
    ready: (p: string) => Promise<{ ok: boolean; tasks: any[] }>
    stats: (p: string) => Promise<{ ok: boolean; stats?: any }>
  }
  swarm: {
    inject: (p: string, req: string) => Promise<{ ok: boolean; id?: string }>
    queueRemove: (p: string, id: string) => Promise<{ ok: boolean }>
    queue: (p: string) => Promise<any[]>
    start: (p: string, n?: number) => Promise<{ ok: boolean }>
    stop: (p: string) => Promise<{ ok: boolean }>
    gracefulStop: (p: string) => Promise<{ ok: boolean }>
    pauseAgent: (p: string, agentId: string) => Promise<{ ok: boolean }>
    resumeAgent: (p: string, agentId: string) => Promise<{ ok: boolean }>
    pauseAll: (p: string) => Promise<{ ok: boolean }>
    resumeAll: (p: string) => Promise<{ ok: boolean }>
    status: (p: string) => Promise<any>
    beads: (p: string, status?: string) => Promise<any[]>
    beadStats: (p: string) => Promise<any>
    activity: (p: string, limit?: number) => Promise<any[]>
    knowledge: (p: string, limit?: number) => Promise<any[]>
    agentOutput: (p: string, agentId: string) => Promise<string>
    agentLogs: (p: string) => Promise<{ file: string; agentId: string; phase: string; timestamp: string; size: number }[]>
    agentLogContent: (p: string, filename: string) => Promise<string>
    onLog: (cb: (...a: any[]) => void) => () => void
    onOutput: (cb: (...a: any[]) => void) => () => void
    onGraph: (cb: (...a: any[]) => void) => () => void
    onAgents: (cb: (...a: any[]) => void) => () => void
    onActivity: (cb: (...a: any[]) => void) => () => void
    onPlanPhase: (cb: (...a: any[]) => void) => () => void
    onPlanQueue: (cb: (...a: any[]) => void) => () => void
    onStopped: (cb: (...a: any[]) => void) => () => void
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
  shell: { openExternal: (url: string) => Promise<void> }
  cleanup: (p?: string) => Promise<void>
}

declare global {
  interface Window {
    slashbot: SlashbotAPI
  }
}
