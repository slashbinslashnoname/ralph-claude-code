import { contextBridge, ipcRenderer } from 'electron'

// ── Types shared with renderer ───────────────────────────────────────────────

export type BeadsTask = {
  id: string; title: string; status: string; priority?: string; tags: string[]
}
export type RalphStatus = {
  timestamp: string; loop_count: number; calls_made_this_hour: number
  max_calls_per_hour: number; last_action: string; status: string
  exit_reason: string; next_reset?: string
}
export type RalphProgress = {
  status: string; indicator?: string; elapsed_seconds?: number
  last_output?: string; timestamp: string; error?: string; files_changed?: number
}
export type CircuitState = {
  state: 'CLOSED' | 'HALF_OPEN' | 'OPEN'
  last_change: string; consecutive_no_progress: number
  consecutive_same_error: number; consecutive_permission_denials: number
  last_progress_loop: number; total_opens: number; reason: string
  current_loop: number; opened_at?: string
}

// ── Expose surface ───────────────────────────────────────────────────────────

contextBridge.exposeInMainWorld('ralph', {
  // ── Project ────────────────────────────────────────────────────
  selectProject:  (): Promise<string | null>   => ipcRenderer.invoke('project:select'),
  recentProjects: (): Promise<string[]>         => ipcRenderer.invoke('project:recent'),
  addProject:     (p: string): Promise<boolean> => ipcRenderer.invoke('project:add', p),

  // ── Status snapshot ────────────────────────────────────────────
  readStatus: (projectPath: string) => ipcRenderer.invoke('status:read', projectPath),

  // ── Live subscriptions (push via ipcRenderer.on) ───────────────
  subscribeStatus:   (projectPath: string) => ipcRenderer.invoke('status:subscribe', projectPath),
  unsubscribeStatus: ()                    => ipcRenderer.invoke('status:unsubscribe'),

  onStatusUpdate:   (cb: (d: RalphStatus)   => void) => listen('status:update',   cb),
  onProgressUpdate: (cb: (d: RalphProgress) => void) => listen('progress:update',  cb),
  onCircuitUpdate:  (cb: (d: CircuitState)  => void) => listen('circuit:update',   cb),
  onAnalysisUpdate: (cb: (d: unknown)       => void) => listen('analysis:update',  cb),
  onFixplanUpdate:  (cb: (content: string)  => void) => listen('fixplan:update',   cb),
  onLogLines:       (cb: (lines: string[])  => void) => listen('logs:lines',       cb),

  // ── Logs ───────────────────────────────────────────────────────
  readLogs: (projectPath: string, lines?: number): Promise<string[]> =>
    ipcRenderer.invoke('logs:read', projectPath, lines),
  listLogs: (projectPath: string): Promise<string[]> =>
    ipcRenderer.invoke('logs:list', projectPath),

  // ── File editor ────────────────────────────────────────────────
  readFile:  (projectPath: string, relPath: string): Promise<{ ok: boolean; content?: string; error?: string }> =>
    ipcRenderer.invoke('file:read', projectPath, relPath),
  writeFile: (projectPath: string, relPath: string, content: string): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('file:write', projectPath, relPath, content),

  // ── Ralph process ──────────────────────────────────────────────
  startRalph:  (projectPath: string, args?: string[]): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('ralph:start', projectPath, args),
  stopRalph:   (): Promise<void>    => ipcRenderer.invoke('ralph:stop'),
  ralphRunning:(): Promise<boolean> => ipcRenderer.invoke('ralph:running'),
  onRalphExit: (cb: (code: number) => void) => listen('ralph:exit', cb),

  // ── PTY (terminal pane) ────────────────────────────────────────
  ptyWrite:  (data: string): Promise<void>            => ipcRenderer.invoke('pty:write', data),
  ptyResize: (cols: number, rows: number): Promise<void> => ipcRenderer.invoke('pty:resize', cols, rows),
  onPtyData: (cb: (data: string) => void) => listen('pty:data', cb),

  // ── Circuit breaker ────────────────────────────────────────────
  resetCircuit:  (projectPath: string): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('circuit:reset', projectPath),
  resetSession:  (projectPath: string): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('session:reset', projectPath),

  // ── Beads ──────────────────────────────────────────────────────
  beads: {
    check: (projectPath: string) => ipcRenderer.invoke('beads:check', projectPath),
    fetch: (projectPath: string, filter?: string) => ipcRenderer.invoke('beads:fetch', projectPath, filter ?? 'open')
  },

  // ── Shell ──────────────────────────────────────────────────────
  shell: {
    openExternal: (url: string): Promise<void> => ipcRenderer.invoke('shell:openExternal', url)
  },

  // ── Cleanup ────────────────────────────────────────────────────
  cleanup: (): Promise<void> => ipcRenderer.invoke('window:cleanup')
})

/** Helper: register a one-way listener, return an unsubscribe function */
function listen<T>(channel: string, cb: (data: T) => void): () => void {
  const handler = (_e: Electron.IpcRendererEvent, data: T): void => cb(data)
  ipcRenderer.on(channel, handler)
  return () => ipcRenderer.removeListener(channel, handler)
}
