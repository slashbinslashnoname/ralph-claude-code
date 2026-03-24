import React, { useState, useEffect, useCallback } from 'react'
import type { UpdateState, UpdateInfo, UpdateProgress } from '../types/ipc'

interface BannerState {
  phase: UpdateState
  info: UpdateInfo | null
  progress: UpdateProgress | null
  error: string | null
  installing: boolean
}

const INITIAL: BannerState = {
  phase: 'idle',
  info: null,
  progress: null,
  error: null,
  installing: false,
}

function formatSpeed(bytesPerSecond: number): string {
  if (bytesPerSecond >= 1_000_000) return `${(bytesPerSecond / 1_000_000).toFixed(1)} MB/s`
  if (bytesPerSecond >= 1_000) return `${(bytesPerSecond / 1_000).toFixed(0)} KB/s`
  return `${bytesPerSecond} B/s`
}

export default function UpdateBanner() {
  const [state, setState] = useState<BannerState>(INITIAL)

  // Hydrate from current state on mount
  useEffect(() => {
    const update = window.slashbot.update
    update.getState().then((s: { state: UpdateState; info?: UpdateInfo; progress?: UpdateProgress; error?: string } | null) => {
      if (!s) return
      setState(prev => ({
        ...prev,
        phase: s.state,
        info: s.info ?? null,
        progress: s.progress ?? null,
        error: s.error ?? null,
      }))
    }).catch(() => {/* ignore — banner stays hidden */})
  }, [])

  // Subscribe to update events
  useEffect(() => {
    const update = window.slashbot.update
    const unsubs = [
      update.onChecking(() => {
        setState(prev => ({ ...prev, phase: 'checking', error: null }))
      }),
      update.onAvailable((info: UpdateInfo) => {
        setState(prev => ({ ...prev, phase: 'available', info, error: null }))
      }),
      update.onNotAvailable(() => {
        setState(prev => ({ ...prev, phase: 'not-available' }))
      }),
      update.onProgress((progress: UpdateProgress) => {
        setState(prev => ({ ...prev, phase: 'downloading', progress }))
      }),
      update.onDownloaded((info: UpdateInfo) => {
        setState(prev => ({ ...prev, phase: 'downloaded', info, error: null }))
      }),
      update.onError((error: string) => {
        setState(prev => ({ ...prev, phase: 'error', error }))
      }),
    ]
    return () => unsubs.forEach(u => u())
  }, [])

  const handleDownload = useCallback(() => {
    window.slashbot.update.download()
  }, [])

  const handleInstall = useCallback(() => {
    setState(prev => ({ ...prev, installing: true }))
    window.slashbot.update.install()
  }, [])

  const handleDismiss = useCallback(() => {
    setState(prev => ({ ...prev, phase: 'idle', error: null }))
  }, [])

  // Hidden states
  if (state.phase === 'idle' || state.phase === 'not-available') return null

  return (
    <div className="update-banner" data-phase={state.phase}>
      {state.phase === 'checking' && (
        <div className="update-banner-content">
          <span className="update-spinner" />
          <span>Checking for updates…</span>
        </div>
      )}

      {state.phase === 'available' && (
        <div className="update-banner-content">
          <span>Version {state.info?.version} is available</span>
          <button className="btn btn-sm btn-primary" onClick={handleDownload}>
            Download
          </button>
        </div>
      )}

      {state.phase === 'downloading' && (
        <div className="update-banner-content">
          <div className="update-progress-bar">
            <div
              className="update-progress-fill"
              style={{ width: state.progress ? `${Math.round(state.progress.percent)}%` : '0%' }}
            />
          </div>
          <span className="update-progress-text">
            {state.progress
              ? `${Math.round(state.progress.percent)}% — ${formatSpeed(state.progress.bytesPerSecond)}`
              : 'Downloading…'}
          </span>
        </div>
      )}

      {state.phase === 'downloaded' && (
        <div className="update-banner-content">
          <span>Version {state.info?.version} ready to install</span>
          <button
            className="btn btn-sm btn-primary"
            onClick={handleInstall}
            disabled={state.installing}
          >
            {state.installing ? 'Restarting…' : 'Restart & Install'}
          </button>
        </div>
      )}

      {state.phase === 'error' && (
        <div className="update-banner-content">
          <span className="update-error-msg">Update error: {state.error}</span>
          <button className="btn btn-sm btn-ghost" onClick={handleDismiss}>
            Dismiss
          </button>
        </div>
      )}
    </div>
  )
}
