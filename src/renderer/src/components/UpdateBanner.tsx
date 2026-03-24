import React, { useState, useEffect } from 'react'
import type { UpdateState, UpdateInfo, UpdateProgress } from '../types/ipc'

export default function UpdateBanner() {
  const [state, setState] = useState<UpdateState>('idle')
  const [info, setInfo] = useState<UpdateInfo | null>(null)
  const [progress, setProgress] = useState<UpdateProgress | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [dismissed, setDismissed] = useState(false)

  useEffect(() => {
    const update = window.slashbot.update
    // Hydrate initial state (guard against null — IPC handler may not be wired yet)
    update.getState().then((s: { state: UpdateState; info?: UpdateInfo; progress?: UpdateProgress; error?: string } | null) => {
      if (!s) return
      setState(s.state)
      if (s.info) setInfo(s.info)
      if (s.progress) setProgress(s.progress)
      if (s.error) setError(s.error)
    }).catch(() => {})

    const unsubs = [
      update.onChecking(() => {
        setState('checking')
        setDismissed(false)
      }),
      update.onAvailable((i: UpdateInfo) => {
        setState('available')
        setInfo(i)
        setDismissed(false)
      }),
      update.onNotAvailable(() => {
        setState('not-available')
      }),
      update.onProgress((p: UpdateProgress) => {
        setState('downloading')
        setProgress(p)
      }),
      update.onDownloaded((i: UpdateInfo) => {
        setState('downloaded')
        setInfo(i)
      }),
      update.onError((err: string) => {
        setState('error')
        setError(err)
        setDismissed(false)
      }),
    ]

    return () => { unsubs.forEach(u => u()) }
  }, [])

  // Hidden states
  if (dismissed || state === 'idle' || state === 'not-available') return null

  return (
    <div className="update-banner" data-state={state}>
      {state === 'checking' && (
        <span className="update-banner-text">Checking for updates...</span>
      )}

      {state === 'available' && info && (
        <>
          <span className="update-banner-text">
            Version {info.version} is available.
          </span>
          <button className="btn btn-sm" onClick={() => window.slashbot.update.download()}>
            Download
          </button>
        </>
      )}

      {state === 'downloading' && progress && (
        <span className="update-banner-text">
          Downloading... {progress.percent.toFixed(0)}%
          {progress.bytesPerSecond > 0 && ` (${(progress.bytesPerSecond / 1024 / 1024).toFixed(1)} MB/s)`}
        </span>
      )}

      {state === 'downloaded' && (
        <>
          <span className="update-banner-text">
            Update ready{info ? ` (v${info.version})` : ''}. Restart to apply.
          </span>
          <button className="btn btn-sm" onClick={() => window.slashbot.update.install()}>
            Restart
          </button>
        </>
      )}

      {state === 'error' && (
        <>
          <span className="update-banner-text">
            Update error{error ? `: ${error}` : ''}
          </span>
          <button className="btn btn-sm" onClick={() => setDismissed(true)}>
            Dismiss
          </button>
        </>
      )}
    </div>
  )
}
