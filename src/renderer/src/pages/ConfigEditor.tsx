import React, { useState, useEffect, useCallback } from 'react'
import type { UpdateState, UpdateInfo, UpdateProgress } from '../types/ipc'

const sb = window.slashbot

interface Props { projectPath: string }

type ActiveTab = 'prompts' | 'telegram' | 'updates'

const PROMPT_FILES = [
  { path: 'PROMPT.md', label: 'PROMPT.md' },
  { path: 'AGENT.md', label: 'AGENT.md' },
]

const NOTIFY_LEVELS = [
  { value: 'all', label: 'All events' },
  { value: 'errors', label: 'Errors only' },
  { value: 'completions', label: 'Completions' },
  { value: 'none', label: 'None' },
] as const

// ---------------------------------------------------------------------------
// Updates section
// ---------------------------------------------------------------------------

interface UpdatesSectionState {
  phase: UpdateState
  info: UpdateInfo | null
  progress: UpdateProgress | null
  error: string | null
  installing: boolean
}

const UPDATES_INITIAL: UpdatesSectionState = {
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

function UpdatesSection() {
  const [state, setState] = useState<UpdatesSectionState>(UPDATES_INITIAL)

  // Hydrate from current updater state on mount
  useEffect(() => {
    sb.update.getState().then(s => {
      if (!s) return
      setState(prev => ({
        ...prev,
        phase: s.state,
        info: s.info ?? null,
        progress: s.progress ?? null,
        error: s.error ?? null,
      }))
    }).catch(() => {/* ignore */})
  }, [])

  // Subscribe to update events
  useEffect(() => {
    const unsubs = [
      sb.update.onChecking(() => {
        setState(prev => ({ ...prev, phase: 'checking', error: null }))
      }),
      sb.update.onAvailable((info: UpdateInfo) => {
        setState(prev => ({ ...prev, phase: 'available', info, error: null }))
      }),
      sb.update.onNotAvailable(() => {
        setState(prev => ({ ...prev, phase: 'not-available' }))
      }),
      sb.update.onProgress((progress: UpdateProgress) => {
        setState(prev => ({ ...prev, phase: 'downloading', progress }))
      }),
      sb.update.onDownloaded((info: UpdateInfo) => {
        setState(prev => ({ ...prev, phase: 'downloaded', info, error: null }))
      }),
      sb.update.onError((error: string) => {
        setState(prev => ({ ...prev, phase: 'error', error }))
      }),
    ]
    return () => unsubs.forEach(u => u())
  }, [])

  const handleCheck = useCallback(() => {
    sb.update.check()
  }, [])

  const handleDownload = useCallback(() => {
    sb.update.download()
  }, [])

  const handleInstall = useCallback(() => {
    setState(prev => ({ ...prev, installing: true }))
    sb.update.install()
  }, [])

  const statusText = (): string => {
    switch (state.phase) {
      case 'idle': return 'No updates checked yet.'
      case 'checking': return 'Checking for updates…'
      case 'available': return `Version ${state.info?.version ?? 'unknown'} is available.`
      case 'not-available': return 'You are on the latest version.'
      case 'downloading': return state.progress
        ? `Downloading… ${Math.round(state.progress.percent)}% — ${formatSpeed(state.progress.bytesPerSecond)}`
        : 'Downloading…'
      case 'downloaded': return `Version ${state.info?.version ?? 'unknown'} is ready to install.`
      case 'error': return `Update error: ${state.error ?? 'Unknown error'}`
    }
  }

  return (
    <div className="updates-section">
      <div className="updates-status-text">{statusText()}</div>

      {state.phase === 'downloading' && (
        <div className="updates-progress-bar">
          <div
            className="updates-progress-fill"
            style={{ width: state.progress ? `${Math.round(state.progress.percent)}%` : '0%' }}
          />
        </div>
      )}

      <div className="form-actions" style={{ marginTop: 12 }}>
        <button
          className="btn btn-primary"
          onClick={handleCheck}
          disabled={state.phase === 'checking' || state.phase === 'downloading'}
        >
          {state.phase === 'checking' ? 'Checking…' : 'Check for Updates'}
        </button>

        {state.phase === 'available' && (
          <button className="btn btn-primary" onClick={handleDownload}>
            Download
          </button>
        )}

        {state.phase === 'downloaded' && (
          <button
            className="btn btn-primary"
            onClick={handleInstall}
            disabled={state.installing}
          >
            {state.installing ? 'Restarting…' : 'Install & Restart'}
          </button>
        )}
      </div>

      {state.info && state.phase !== 'idle' && state.phase !== 'not-available' && (
        <div className="updates-version-info">
          <div className="updates-version-label">Version {state.info.version}</div>
          {state.info.releaseDate && (
            <div className="updates-release-date">{state.info.releaseDate}</div>
          )}
          {state.info.releaseNotes && (
            <div className="updates-release-notes">{state.info.releaseNotes}</div>
          )}
        </div>
      )}

      {state.phase === 'error' && (
        <div className="alert alert-danger" style={{ marginTop: 10 }}>
          {state.error}
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Telegram section
// ---------------------------------------------------------------------------

interface TelegramStatus {
  connected: boolean
  botUsername: string | null
  lastError: string | null
  messagesSent: number
  messagesReceived: number
}

function TelegramSection({ projectPath }: { projectPath: string }) {
  const [botToken, setBotToken] = useState('')
  const [chatId, setChatId] = useState('')
  const [notifyLevel, setNotifyLevel] = useState('errors')
  const [enabled, setEnabled] = useState(false)
  const [status, setStatus] = useState<TelegramStatus | null>(null)
  const [testResult, setTestResult] = useState<{ ok: boolean; error?: string } | null>(null)
  const [testing, setTesting] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saveResult, setSaveResult] = useState<{ ok: boolean; error?: string } | null>(null)

  const loadStatus = useCallback(async () => {
    const s = await sb.telegram.status(projectPath)
    setStatus(s)
  }, [projectPath])

  // Load current config and status on mount / when tab is shown
  useEffect(() => {
    loadStatus()
    sb.config.read(projectPath).then(config => {
      const tg = config.telegram
      if (!tg) return
      setBotToken(tg.botToken)
      setChatId(tg.chatId)
      setNotifyLevel(tg.notifyOn)
      setEnabled(tg.enabled)
    })
  }, [projectPath, loadStatus])

  const handleSave = useCallback(async () => {
    setSaving(true)
    setSaveResult(null)
    setTestResult(null)
    try {
      if (enabled && botToken && chatId) {
        const r = await sb.telegram.configure(projectPath, { botToken, chatId, notifyLevel })
        setSaveResult(r)
        if (r.ok) await loadStatus()
      } else if (!enabled && status?.connected) {
        await sb.telegram.disconnect(projectPath)
        await loadStatus()
        setSaveResult({ ok: true })
      } else {
        setSaveResult({ ok: true })
      }
    } catch (e) {
      setSaveResult({ ok: false, error: e instanceof Error ? e.message : String(e) })
    }
    setSaving(false)
  }, [projectPath, botToken, chatId, notifyLevel, enabled, status, loadStatus])

  const handleTest = useCallback(async () => {
    setTesting(true)
    setTestResult(null)
    try {
      const r = await sb.telegram.test(projectPath)
      setTestResult(r)
    } catch (e) {
      setTestResult({ ok: false, error: e instanceof Error ? e.message : String(e) })
    }
    setTesting(false)
  }, [projectPath])

  const handleDisconnect = useCallback(async () => {
    await sb.telegram.disconnect(projectPath)
    setEnabled(false)
    setTestResult(null)
    setSaveResult(null)
    await loadStatus()
  }, [projectPath, loadStatus])

  const connected = status?.connected ?? false

  return (
    <div className="telegram-section">
      <div className="telegram-status-bar">
        <span className={`telegram-dot ${connected ? 'connected' : 'disconnected'}`} />
        <span className="telegram-status-text">
          {connected
            ? `Connected as @${status?.botUsername ?? 'unknown'}`
            : 'Not connected'}
        </span>
        {connected && status?.messagesSent != null && (
          <span className="telegram-msg-count">{status.messagesSent} sent</span>
        )}
      </div>

      <div className="form-grid">
        <div className="form-group">
          <label>Bot Token</label>
          <input
            type="password"
            className="input"
            value={botToken}
            onChange={e => setBotToken(e.target.value)}
            placeholder="123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11"
            autoComplete="off"
          />
        </div>

        <div className="form-group">
          <label>Chat ID</label>
          <input
            type="text"
            className="input"
            value={chatId}
            onChange={e => setChatId(e.target.value)}
            placeholder="-1001234567890"
          />
        </div>

        <div className="form-group">
          <label>Notify Level</label>
          <select
            className="select"
            value={notifyLevel}
            onChange={e => setNotifyLevel(e.target.value)}
          >
            {NOTIFY_LEVELS.map(l => (
              <option key={l.value} value={l.value}>{l.label}</option>
            ))}
          </select>
        </div>

        <label className="toggle-label">
          <input
            type="checkbox"
            checked={enabled}
            onChange={e => setEnabled(e.target.checked)}
          />
          Enable Telegram notifications
        </label>
      </div>

      <div className="telegram-warning">
        Do not commit .slashbotrc with your bot token to version control.
        Add it to .gitignore.
      </div>

      <div className="form-actions" style={{ marginTop: 12 }}>
        <button
          className="btn btn-primary"
          onClick={handleSave}
          disabled={saving || (!botToken && enabled) || (!chatId && enabled)}
        >
          {saving ? 'Saving...' : 'Save'}
        </button>
        <button
          className="btn btn-ghost"
          onClick={handleTest}
          disabled={testing || !connected}
        >
          {testing ? 'Testing...' : 'Test Connection'}
        </button>
        {connected && (
          <button className="btn btn-danger" onClick={handleDisconnect}>
            Disconnect
          </button>
        )}
      </div>

      {testResult && (
        <div className={`alert ${testResult.ok ? 'alert-success' : 'alert-danger'}`} style={{ marginTop: 10 }}>
          {testResult.ok ? 'Test message sent successfully!' : `Test failed: ${testResult.error}`}
        </div>
      )}
      {saveResult && (
        <div className={`alert ${saveResult.ok ? 'alert-success' : 'alert-danger'}`} style={{ marginTop: 10 }}>
          {saveResult.ok ? 'Configuration saved.' : `Save failed: ${saveResult.error}`}
        </div>
      )}
    </div>
  )
}

export default function ConfigEditor({ projectPath }: Props) {
  const [activeTab, setActiveTab] = useState<ActiveTab>('prompts')
  const [activeFile, setActiveFile] = useState('PROMPT.md')
  const [content, setContent] = useState('')
  const [saved, setSaved] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    if (activeTab !== 'prompts') return
    sb.readFile(projectPath, activeFile).then(r => {
      if (r.ok) { setContent(r.content!); setSaved(true); setError('') }
      else setError(r.error ?? 'Failed to read file')
    })
  }, [projectPath, activeFile, activeTab])

  const save = useCallback(async () => {
    const r = await sb.writeFile(projectPath, activeFile, content)
    if (r.ok) { setSaved(true); setError('') }
    else setError(r.error ?? 'Failed to save')
  }, [projectPath, activeFile, content])

  return (
    <div className="page">
      <header className="page-header">
        <h2>Configuration</h2>
        {activeTab === 'prompts' && (
          <div className="header-actions">
            <button className="btn btn-primary" onClick={save} disabled={saved}>
              {saved ? 'Saved' : 'Save'}
            </button>
          </div>
        )}
      </header>
      <div className="config-tabs">
        <button
          className={`tab ${activeTab === 'prompts' ? 'active' : ''}`}
          onClick={() => setActiveTab('prompts')}
        >
          Prompts
        </button>
        <button
          className={`tab ${activeTab === 'telegram' ? 'active' : ''}`}
          onClick={() => setActiveTab('telegram')}
        >
          Telegram
        </button>
        <button
          className={`tab ${activeTab === 'updates' ? 'active' : ''}`}
          onClick={() => setActiveTab('updates')}
        >
          Updates
        </button>
      </div>
      {activeTab === 'prompts' && (
        <>
          <div className="prompt-toggle">
            {PROMPT_FILES.map(f => (
              <button
                key={f.path}
                className={`prompt-toggle-btn ${activeFile === f.path ? 'active' : ''}`}
                onClick={() => setActiveFile(f.path)}
              >
                {f.label}
              </button>
            ))}
          </div>
          {error && <div className="alert alert-danger">{error}</div>}
          <textarea
            className="code-editor"
            value={content}
            onChange={e => { setContent(e.target.value); setSaved(false) }}
            onKeyDown={e => { if (e.key === 's' && e.metaKey) { e.preventDefault(); save() } }}
            spellCheck={false}
          />
        </>
      )}
      {activeTab === 'telegram' && <TelegramSection projectPath={projectPath} />}
      {activeTab === 'updates' && <UpdatesSection />}
    </div>
  )
}
