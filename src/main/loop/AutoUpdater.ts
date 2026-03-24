import { EventEmitter } from 'events'
import { autoUpdater } from 'electron-updater'
import type { UpdateState, UpdateInfo, UpdateProgress } from '../types'

/**
 * Wraps electron-updater's autoUpdater into an EventEmitter with a simple
 * state-machine API.  Emits typed events that map 1-to-1 to the IPC broadcast
 * channels consumed by the renderer.
 *
 * Events emitted:
 *   checking, available, not-available, progress, downloaded, error
 */
export class AutoUpdater extends EventEmitter {
  private _state: UpdateState = 'idle'

  constructor() {
    super()
    this._wireEvents()
  }

  get state(): UpdateState {
    return this._state
  }

  /** Trigger a check for updates. */
  async check(): Promise<void> {
    await autoUpdater.checkForUpdates()
  }

  /** Download the available update. */
  async download(): Promise<void> {
    await autoUpdater.downloadUpdate()
  }

  /** Quit the app and install the downloaded update. */
  quitAndInstall(): void {
    autoUpdater.quitAndInstall()
  }

  /** Return current state + cached info for the renderer. */
  getState(): { state: UpdateState } {
    return { state: this._state }
  }

  private _wireEvents(): void {
    autoUpdater.autoDownload = false
    autoUpdater.autoInstallOnAppQuit = false

    autoUpdater.on('checking-for-update', () => {
      this._state = 'checking'
      this.emit('checking')
    })

    autoUpdater.on('update-available', (info: UpdateInfo) => {
      this._state = 'available'
      this.emit('available', info)
    })

    autoUpdater.on('update-not-available', (info: UpdateInfo) => {
      this._state = 'not-available'
      this.emit('not-available', info)
    })

    autoUpdater.on('download-progress', (progress: UpdateProgress) => {
      this._state = 'downloading'
      this.emit('progress', progress)
    })

    autoUpdater.on('update-downloaded', (info: UpdateInfo) => {
      this._state = 'downloaded'
      this.emit('downloaded', info)
    })

    autoUpdater.on('error', (err: Error) => {
      this._state = 'error'
      this.emit('error', err.message)
    })
  }
}
