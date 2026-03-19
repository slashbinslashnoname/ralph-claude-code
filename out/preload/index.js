"use strict";
const electron = require("electron");
electron.contextBridge.exposeInMainWorld("ralph", {
  // ── Project management ──────────────────────────────────────────────────
  selectProject: () => electron.ipcRenderer.invoke("project:select"),
  recentProjects: () => electron.ipcRenderer.invoke("project:recent"),
  addProject: (p) => electron.ipcRenderer.invoke("project:add", p),
  // ── Ralph enable (replaces ralph_enable.sh) ─────────────────────────────
  isEnabled: (projectPath) => electron.ipcRenderer.invoke("ralph:is-enabled", projectPath),
  enable: (projectPath, opts) => electron.ipcRenderer.invoke("ralph:enable", projectPath, opts),
  // ── Status snapshot (one-shot) ──────────────────────────────────────────
  readStatus: (projectPath) => electron.ipcRenderer.invoke("status:read", projectPath),
  // ── Live file-change subscriptions ─────────────────────────────────────
  subscribeStatus: (projectPath) => electron.ipcRenderer.invoke("status:subscribe", projectPath),
  unsubscribeStatus: (projectPath) => electron.ipcRenderer.invoke("status:unsubscribe", projectPath),
  // Push callbacks — all include projectPath as first arg
  onStatusUpdate: (cb) => listen("status:update", cb),
  onProgressUpdate: (cb) => listen("progress:update", cb),
  onCircuitUpdate: (cb) => listen("circuit:update", cb),
  onAnalysisUpdate: (cb) => listen("analysis:update", cb),
  onFixplanUpdate: (cb) => listen("fixplan:update", cb),
  onLogLines: (cb) => listen("logs:lines", cb),
  onRalphExit: (cb) => listen("ralph:exit", cb),
  onPtyData: (cb) => listen("pty:data", cb),
  // ── Logs ────────────────────────────────────────────────────────────────
  readLogs: (projectPath, lines) => electron.ipcRenderer.invoke("logs:read", projectPath, lines),
  listLogs: (projectPath) => electron.ipcRenderer.invoke("logs:list", projectPath),
  // ── File editor ─────────────────────────────────────────────────────────
  readFile: (projectPath, relPath) => electron.ipcRenderer.invoke("file:read", projectPath, relPath),
  writeFile: (projectPath, relPath, content) => electron.ipcRenderer.invoke("file:write", projectPath, relPath, content),
  // ── Ralph loop (TS engine) ───────────────────────────────────────────────
  startRalph: (projectPath) => electron.ipcRenderer.invoke("ralph:start", projectPath),
  stopRalph: (projectPath) => electron.ipcRenderer.invoke("ralph:stop", projectPath),
  ralphRunning: (projectPath) => electron.ipcRenderer.invoke("ralph:running", projectPath),
  // ── Terminal output (Claude stdout forwarded via pty:data) ───────────────
  ptyWrite: (projectPath, data) => electron.ipcRenderer.invoke("pty:write", projectPath, data),
  ptyResize: (cols, rows) => electron.ipcRenderer.invoke("pty:resize", cols, rows),
  // ── Circuit breaker & session ────────────────────────────────────────────
  resetCircuit: (projectPath) => electron.ipcRenderer.invoke("circuit:reset", projectPath),
  resetSession: (projectPath) => electron.ipcRenderer.invoke("session:reset", projectPath),
  // ── Fix plan task injection ──────────────────────────────────────────────
  addTask: (projectPath, task) => electron.ipcRenderer.invoke("fixplan:add-task", projectPath, task),
  // ── Beads ────────────────────────────────────────────────────────────────
  beads: {
    check: (projectPath) => electron.ipcRenderer.invoke("beads:check", projectPath),
    fetch: (projectPath, filter) => electron.ipcRenderer.invoke("beads:fetch", projectPath, filter ?? "open")
  },
  // ── Shell ────────────────────────────────────────────────────────────────
  shell: {
    openExternal: (url) => electron.ipcRenderer.invoke("shell:openExternal", url)
  },
  // ── Cleanup ──────────────────────────────────────────────────────────────
  cleanup: (projectPath) => electron.ipcRenderer.invoke("window:cleanup", projectPath)
});
function listen(channel, cb) {
  const handler = (_e, ...args) => cb(...args);
  electron.ipcRenderer.on(channel, handler);
  return () => electron.ipcRenderer.removeListener(channel, handler);
}
