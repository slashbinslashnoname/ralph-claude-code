import { contextBridge, ipcRenderer } from 'electron'

function listen(channel: string, cb: (...args: unknown[]) => void): () => void {
  const handler = (_e: unknown, ...args: unknown[]): void => cb(...args)
  ipcRenderer.on(channel, handler)
  return () => ipcRenderer.removeListener(channel, handler)
}

contextBridge.exposeInMainWorld('slashbot', {
  // ── Project management ──────────────────────────────────────────────────
  selectProject: () => ipcRenderer.invoke('project:select'),
  recentProjects: () => ipcRenderer.invoke('project:recent'),
  addProject: (p: string) => ipcRenderer.invoke('project:add', p),
  activeProjectTabs: () => ipcRenderer.invoke('project:active-tabs'),
  saveActiveProjectTabs: (tabs: { paths: string[]; active: number }) =>
    ipcRenderer.invoke('project:save-tabs', tabs),

  // ── Slashbot enable ────────────────────────────────────────────────────────
  isEnabled: (projectPath: string) => ipcRenderer.invoke('slashbot:is-enabled', projectPath),
  enable: (projectPath: string, opts: unknown) => ipcRenderer.invoke('slashbot:enable', projectPath, opts),
  // ── Status ──────────────────────────────────────────────────────────────
  readStatus: (projectPath: string) => ipcRenderer.invoke('status:read', projectPath),
  subscribeProject: (projectPath: string) => ipcRenderer.invoke('status:subscribe', projectPath),
  unsubscribeProject: (projectPath: string) => ipcRenderer.invoke('status:unsubscribe', projectPath),

  onCircuitUpdate: (cb: (...a: unknown[]) => void) => listen('circuit:update', cb),
  onLogLines: (cb: (...a: unknown[]) => void) => listen('logs:lines', cb),

  // ── Logs ────────────────────────────────────────────────────────────────
  readLogs: (projectPath: string, lines?: number) => ipcRenderer.invoke('logs:read', projectPath, lines),
  listLogs: (projectPath: string) => ipcRenderer.invoke('logs:list', projectPath),

  // ── File editor ───────────────────────────────────────────────────────
  readFile: (projectPath: string, relPath: string) => ipcRenderer.invoke('file:read', projectPath, relPath),
  writeFile: (projectPath: string, relPath: string, content: string) =>
    ipcRenderer.invoke('file:write', projectPath, relPath, content),

  // ── Circuit breaker & session ────────────────────────────────────────
  resetCircuit: (projectPath: string, agentId?: string) =>
    ipcRenderer.invoke('circuit:reset', projectPath, agentId ? { agentId } : undefined),
  clearStaleCircuits: (projectPath: string) =>
    ipcRenderer.invoke('circuit:clear-stale', projectPath),
  onCircuitRemove: (cb: (...a: unknown[]) => void) => listen('circuit:remove', cb),
  resetSession: (projectPath: string) => ipcRenderer.invoke('session:reset', projectPath),

  // ── Memories (via bd CLI) ─────────────────────────────────────────────
  memories: {
    list: (projectPath: string) => ipcRenderer.invoke('memories:list', projectPath),
    add: (projectPath: string, text: string, key?: string) =>
      ipcRenderer.invoke('memories:add', projectPath, text, key),
    forget: (projectPath: string, key: string) =>
      ipcRenderer.invoke('memories:forget', projectPath, key),
  },

  // ── Beads (via bd CLI) ───────────────────────────────────────────────
  beads: {
    check: (projectPath: string) => ipcRenderer.invoke('beads:check', projectPath),
    installCheck: () => ipcRenderer.invoke('beads:install-check'),
    init: (projectPath: string) => ipcRenderer.invoke('beads:init', projectPath),
    list: (projectPath: string, filter?: string) =>
      ipcRenderer.invoke('beads:list', projectPath, filter ?? 'open'),
    show: (projectPath: string, id: string) => ipcRenderer.invoke('beads:show', projectPath, id),
    create: (projectPath: string, opts: unknown) => ipcRenderer.invoke('beads:create', projectPath, opts),
    update: (projectPath: string, id: string, opts: unknown) =>
      ipcRenderer.invoke('beads:update', projectPath, id, opts),
    close: (projectPath: string, id: string, reason?: string) =>
      ipcRenderer.invoke('beads:close', projectPath, id, reason ?? 'Done'),
    reopen: (projectPath: string, id: string, reason?: string) =>
      ipcRenderer.invoke('beads:reopen', projectPath, id, reason),
    rollback: (projectPath: string, id: string, agentId?: string) =>
      ipcRenderer.invoke('beads:rollback', projectPath, id, agentId),
    ready: (projectPath: string) => ipcRenderer.invoke('beads:ready', projectPath),
    stats: (projectPath: string) => ipcRenderer.invoke('beads:stats', projectPath),
    comments: (projectPath: string, id: string) =>
      ipcRenderer.invoke('comments:list', projectPath, id),
    addComment: (projectPath: string, id: string, text: string) =>
      ipcRenderer.invoke('comments:add', projectPath, id, text),
  },

  // ── Swarm orchestrator ───────────────────────────────────────────────
  swarm: {
    inject: (projectPath: string, request: string) =>
      ipcRenderer.invoke('swarm:inject', projectPath, request),
    queueRemove: (projectPath: string, id: string) =>
      ipcRenderer.invoke('swarm:queue-remove', projectPath, id),
    queue: (projectPath: string) => ipcRenderer.invoke('swarm:queue', projectPath),
    start: (projectPath: string, workerCount?: number) =>
      ipcRenderer.invoke('swarm:start', projectPath, workerCount ?? 2),
    stop: (projectPath: string) => ipcRenderer.invoke('swarm:stop', projectPath),
    gracefulStop: (projectPath: string) => ipcRenderer.invoke('swarm:graceful-stop', projectPath),
    pauseAgent: (projectPath: string, agentId: string) =>
      ipcRenderer.invoke('swarm:pause-agent', projectPath, agentId),
    resumeAgent: (projectPath: string, agentId: string) =>
      ipcRenderer.invoke('swarm:resume-agent', projectPath, agentId),
    pauseAll: (projectPath: string) => ipcRenderer.invoke('swarm:pause-all', projectPath),
    resumeAll: (projectPath: string) => ipcRenderer.invoke('swarm:resume-all', projectPath),
    status: (projectPath: string) => ipcRenderer.invoke('swarm:status', projectPath),
    beads: (projectPath: string, status?: string) =>
      ipcRenderer.invoke('swarm:beads', projectPath, status),
    beadStats: (projectPath: string) => ipcRenderer.invoke('swarm:bead-stats', projectPath),
    activity: (projectPath: string, limit?: number) =>
      ipcRenderer.invoke('swarm:activity', projectPath, limit ?? 50),
    activityForBead: (projectPath: string, beadId: string, limit?: number) =>
      ipcRenderer.invoke('swarm:activity-for-bead', projectPath, beadId, limit ?? 50),
    activityForAgent: (projectPath: string, agentId: string, limit?: number) =>
      ipcRenderer.invoke('swarm:activity-for-agent', projectPath, agentId, limit ?? 50),
    activityHistory: (projectPath: string, before?: string, limit?: number) =>
      ipcRenderer.invoke('swarm:activity-history', projectPath, before, limit ?? 50),
    knowledge: (projectPath: string, limit?: number) =>
      ipcRenderer.invoke('swarm:knowledge', projectPath, limit ?? 50),
    agentOutput: (projectPath: string, agentId: string) =>
      ipcRenderer.invoke('swarm:agent-output', projectPath, agentId),
    agentLogs: (projectPath: string) =>
      ipcRenderer.invoke('swarm:agent-logs', projectPath),
    agentLogContent: (projectPath: string, filename: string) =>
      ipcRenderer.invoke('swarm:agent-log-content', projectPath, filename),
    onLog: (cb: (...a: unknown[]) => void) => listen('swarm:log', cb),
    onOutput: (cb: (...a: unknown[]) => void) => listen('swarm:output', cb),
    onGraph: (cb: (...a: unknown[]) => void) => listen('swarm:graph', cb),
    onAgents: (cb: (...a: unknown[]) => void) => listen('swarm:agents', cb),
    onActivity: (cb: (...a: unknown[]) => void) => listen('swarm:activity', cb),
    planApprove: (projectPath: string, modifiedPlan?: string) =>
      ipcRenderer.invoke('swarm:plan-approve', projectPath, modifiedPlan),
    planReject: (projectPath: string) =>
      ipcRenderer.invoke('swarm:plan-reject', projectPath),
    onPlanPhase: (cb: (...a: unknown[]) => void) => listen('swarm:planPhase', cb),
    onPlanThinking: (cb: (...a: unknown[]) => void) => listen('swarm:planThinking', cb),
    onPlanQueue: (cb: (...a: unknown[]) => void) => listen('swarm:planQueue', cb),
    onStopped: (cb: (...a: unknown[]) => void) => listen('swarm:stopped', cb),
    onSwarmPhase: (cb: (...a: unknown[]) => void) => listen('swarm:swarmPhase', cb),
    buildMonitor: {
      toggle: (projectPath: string, enabled: boolean) =>
        ipcRenderer.invoke('swarm:build-monitor-toggle', projectPath, enabled),
      status: (projectPath: string) =>
        ipcRenderer.invoke('swarm:build-monitor-status', projectPath),
    },
    onBuildStatus: (cb: (...a: unknown[]) => void) => listen('swarm:build-status', cb),
  },

  // ── File locks ──────────────────────────────────────────────────────
  locks: {
    list: (projectPath: string) => ipcRenderer.invoke('locks:list', projectPath),
    forceUnlock: (projectPath: string, beadId: string) =>
      ipcRenderer.invoke('locks:force-unlock', projectPath, beadId),
  },

  // ── Telegram ─────────────────────────────────────────────────────────
  telegram: {
    status: (projectPath: string) => ipcRenderer.invoke('telegram:status', projectPath),
    configure: (projectPath: string, config: unknown) =>
      ipcRenderer.invoke('telegram:configure', projectPath, config),
    test: (projectPath: string) => ipcRenderer.invoke('telegram:test', projectPath),
    disconnect: (projectPath: string) => ipcRenderer.invoke('telegram:disconnect', projectPath),
  },

  // ── Config (structured settings) ────────────────────────────────────
  config: {
    read: (projectPath: string) => ipcRenderer.invoke('config:read', projectPath),
    write: (projectPath: string, updates: Record<string, unknown>) =>
      ipcRenderer.invoke('config:write', projectPath, updates),
  },

  // ── Update ─────────────────────────────────────────────────────────
  update: {
    check: () => ipcRenderer.invoke('update:check'),
    download: () => ipcRenderer.invoke('update:download'),
    install: () => ipcRenderer.invoke('update:install'),
    getState: () => ipcRenderer.invoke('update:state'),
    onChecking: (cb: (...a: unknown[]) => void) => listen('update:checking', cb),
    onAvailable: (cb: (...a: unknown[]) => void) => listen('update:available', cb),
    onNotAvailable: (cb: (...a: unknown[]) => void) => listen('update:not-available', cb),
    onProgress: (cb: (...a: unknown[]) => void) => listen('update:progress', cb),
    onDownloaded: (cb: (...a: unknown[]) => void) => listen('update:downloaded', cb),
    onError: (cb: (...a: unknown[]) => void) => listen('update:error', cb),
  },

  // ── Shell ────────────────────────────────────────────────────────────
  shell: {
    openExternal: (url: string) => ipcRenderer.invoke('shell:openExternal', url),
  },

  // ── Cleanup ──────────────────────────────────────────────────────────
  cleanup: (projectPath?: string) => ipcRenderer.invoke('window:cleanup', projectPath),
})
