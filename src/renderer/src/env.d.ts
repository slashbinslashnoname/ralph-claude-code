/// <reference types="vite/client" />

interface RalphAPI {
  selectProject: () => Promise<string | null>
  recentProjects: () => Promise<string[]>
  addProject: (p: string) => Promise<boolean>
  activeProjectTabs: () => Promise<{ paths: string[]; active: number }>
  saveActiveProjectTabs: (tabs: { paths: string[]; active: number }) => Promise<boolean>
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
  onRalphExit: (cb: (...a: any[]) => void) => () => void
  onPtyData: (cb: (...a: any[]) => void) => () => void
  readLogs: (p: string, lines?: number) => Promise<string[]>
  listLogs: (p: string) => Promise<string[]>
  readFile: (p: string, rel: string) => Promise<{ ok: boolean; content?: string; error?: string }>
  writeFile: (p: string, rel: string, c: string) => Promise<{ ok: boolean; error?: string }>
  startRalph: (p: string) => Promise<{ ok: boolean; error?: string }>
  stopRalph: (p: string) => Promise<void>
  ralphRunning: (p: string) => Promise<boolean>
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
    ready: (p: string) => Promise<{ ok: boolean; tasks: any[] }>
    stats: (p: string) => Promise<{ ok: boolean; stats?: any }>
  }
  swarm: {
    inject: (p: string, req: string) => Promise<{ ok: boolean; id?: string }>
    queueRemove: (p: string, id: string) => Promise<{ ok: boolean }>
    queue: (p: string) => Promise<any[]>
    start: (p: string, n?: number) => Promise<{ ok: boolean }>
    stop: (p: string) => Promise<{ ok: boolean }>
    status: (p: string) => Promise<any>
    beads: (p: string, status?: string) => Promise<any[]>
    beadStats: (p: string) => Promise<any>
    activity: (p: string, limit?: number) => Promise<any[]>
    agentOutput: (p: string, agentId: string) => Promise<string>
    onLog: (cb: (...a: any[]) => void) => () => void
    onOutput: (cb: (...a: any[]) => void) => () => void
    onGraph: (cb: (...a: any[]) => void) => () => void
    onAgents: (cb: (...a: any[]) => void) => () => void
    onMail: (cb: (...a: any[]) => void) => () => void
    onPlanPhase: (cb: (...a: any[]) => void) => () => void
    onPlanQueue: (cb: (...a: any[]) => void) => () => void
    onStopped: (cb: (...a: any[]) => void) => () => void
  }
  shell: { openExternal: (url: string) => Promise<void> }
  cleanup: (p?: string) => Promise<void>
}

declare global {
  interface Window {
    ralph: RalphAPI
  }
}
