import { EventEmitter } from 'events'
import { app, type BrowserWindow } from 'electron'
import { autoUpdater } from 'electron-updater'
import type { UpdateState, UpdateInfo, UpdateProgress, UpdateEvent } from '../types'

const STARTUP_DELAY_MS = 30_000
const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000 // 4 hours

/**
 * Wraps electron-updater to provide automatic update checking, downloading,
 * and installation. Broadcasts UpdateEvent payloads to all BrowserWindows
 * via IPC.
 *
 * Guards all methods with `app.isPackaged` — in dev builds every operation
 * is a no-op so electron-updater never hits the network.
 */
export class AutoUpdater extends EventEmitter {
  private _getWindow: () => BrowserWindow | null
  private _state: UpdateState = 'idle'
  private _startupTimer: ReturnType<typeof setTimeout> | null = null
  private _intervalTimer: ReturnType<typeof setInterval> | null = null
  private _latestInfo: UpdateInfo | null = null
  private _started = false

  constructor(getWindow: () => BrowserWindow | null) {
    super()
    this._getWindow = getWindow

    // Disable automatic behaviour — callers control the lifecycle explicitly
    autoUpdater.autoDownload = false
    autoUpdater.autoInstallOnAppQuit = false

    this._bindEvents()
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /** Start periodic update checks (30 s delay, then every 4 h). */
  start(): void {
    if (this._started) return
    if (!app.isPackaged) {
      this.emit('log', 'info', 'AutoUpdater: skipping (not packaged)')
      return
    }
    this._started = true
    this.emit('log', 'info', 'AutoUpdater: started')

    this._startupTimer = setTimeout(() => {
      this.checkForUpdates()
      this._intervalTimer = setInterval(() => this.checkForUpdates(), CHECK_INTERVAL_MS)
    }, STARTUP_DELAY_MS)
  }

  /** Cancel all timers and detach listeners. */
  destroy(): void {
    if (this._startupTimer) {
      clearTimeout(this._startupTimer)
      this._startupTimer = null
    }
    if (this._intervalTimer) {
      clearInterval(this._intervalTimer)
      this._intervalTimer = null
    }
    this._started = false
    autoUpdater.removeAllListeners()
    this.emit('log', 'info', 'AutoUpdater: destroyed')
  }

  /** Trigger a manual update check. No-op in dev. */
  async checkForUpdates(): Promise<void> {
    if (!app.isPackaged) return
    if (this._state === 'checking' || this._state === 'downloading') return
    try {
      await autoUpdater.checkForUpdates()
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      this.emit('log', 'error', `AutoUpdater: check failed — ${msg}`)
      this._broadcast({ type: 'error', error: msg })
      this._state = 'error'
    }
  }

  /** Begin downloading the available update. No-op in dev. */
  async downloadUpdate(): Promise<void> {
    if (!app.isPackaged) return
    if (this._state !== 'available') return
    try {
      await autoUpdater.downloadUpdate()
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      this.emit('log', 'error', `AutoUpdater: download failed — ${msg}`)
      this._broadcast({ type: 'error', error: msg })
      this._state = 'error'
    }
  }

  /** Quit the app and install the downloaded update. No-op in dev. */
  quitAndInstall(): void {
    if (!app.isPackaged) return
    if (this._state !== 'downloaded') return
    autoUpdater.quitAndInstall()
  }

  /** Current update state. */
  get state(): UpdateState {
    return this._state
  }

  /** Info about the latest available update (if any). */
  get latestInfo(): UpdateInfo | null {
    return this._latestInfo
  }

  // ---------------------------------------------------------------------------
  // Internal
  // ---------------------------------------------------------------------------

  /** Wire up electron-updater events → state + IPC broadcast. */
  private _bindEvents(): void {
    autoUpdater.on('checking-for-update', () => {
      this._state = 'checking'
      this.emit('log', 'info', 'AutoUpdater: checking for updates…')
      this._broadcast({ type: 'checking' })
    })

    autoUpdater.on('update-available', (info) => {
      this._state = 'available'
      this._latestInfo = this._toUpdateInfo(info)
      this.emit('log', 'info', `AutoUpdater: update available — v${this._latestInfo.version}`)
      this._broadcast({ type: 'available', info: this._latestInfo })
    })

    autoUpdater.on('update-not-available', (info) => {
      this._state = 'not-available'
      const ui = this._toUpdateInfo(info)
      this.emit('log', 'info', `AutoUpdater: up to date (v${ui.version})`)
      this._broadcast({ type: 'not-available', info: ui })
    })

    autoUpdater.on('download-progress', (progress) => {
      this._state = 'downloading'
      const p: UpdateProgress = {
        percent: progress.percent,
        bytesPerSecond: progress.bytesPerSecond,
        transferred: progress.transferred,
        total: progress.total,
      }
      this._broadcast({ type: 'progress', progress: p })
    })

    autoUpdater.on('update-downloaded', (info) => {
      this._state = 'downloaded'
      this._latestInfo = this._toUpdateInfo(info)
      this.emit('log', 'info', `AutoUpdater: update downloaded — v${this._latestInfo.version}`)
      this._broadcast({ type: 'downloaded', info: this._latestInfo })
    })

    autoUpdater.on('error', (err) => {
      this._state = 'error'
      const msg = err?.message ?? String(err)
      this.emit('log', 'error', `AutoUpdater: error — ${msg}`)
      this._broadcast({ type: 'error', error: msg })
    })
  }

  /** Normalize electron-updater info to our UpdateInfo shape. */
  private _toUpdateInfo(raw: { version: string; releaseDate?: string; releaseNotes?: string | Array<{ note: string }> | null }): UpdateInfo {
    let notes: string | null = null
    if (typeof raw.releaseNotes === 'string') {
      notes = raw.releaseNotes
    } else if (Array.isArray(raw.releaseNotes)) {
      notes = raw.releaseNotes.map((n) => n.note).join('\n')
    }
    return {
      version: raw.version,
      releaseDate: raw.releaseDate ?? '',
      releaseNotes: notes,
    }
  }

  /** Send an UpdateEvent to all open BrowserWindows via IPC. */
  private _broadcast(event: UpdateEvent): void {
    this.emit('update-event', event)
    const win = this._getWindow()
    if (win && !win.isDestroyed()) {
      win.webContents.send('update:event', event)
    }
  }
}
