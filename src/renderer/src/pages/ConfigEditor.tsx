import React, { useState, useEffect, useCallback } from 'react'

const sb = window.slashbot

interface Props { projectPath: string }

type ActiveTab = 'file' | 'telegram'

const EDITABLE_FILES = [
  { path: '.slashbotrc', label: 'Configuration (.slashbotrc)' },
  { path: 'PROMPT.md', label: 'Prompt (PROMPT.md)' },
  { path: 'AGENT.md', label: 'Agent (AGENT.md)' },
]

const NOTIFY_LEVELS = [
  { value: 'all', label: 'All events' },
  { value: 'errors', label: 'Errors only' },
  { value: 'completions', label: 'Completions' },
  { value: 'none', label: 'None' },
] as const

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

  // Load current config from .slashbotrc and status on mount / when tab is shown
  useEffect(() => {
    loadStatus()
    // Read .slashbotrc to populate form fields
    sb.readFile(projectPath, '.slashbotrc').then(r => {
      if (!r.ok) return
      const lines = (r.content ?? '').split('\n')
      for (const line of lines) {
        const trimmed = line.trim()
        if (trimmed.startsWith('#') || !trimmed.includes('=')) continue
        const eqIdx = trimmed.indexOf('=')
        const key = trimmed.slice(0, eqIdx).trim()
        const val = trimmed.slice(eqIdx + 1).trim()
        if (key === 'TELEGRAM_BOT_TOKEN') setBotToken(val)
        else if (key === 'TELEGRAM_CHAT_ID') setChatId(val)
        else if (key === 'TELEGRAM_NOTIFY_LEVEL') setNotifyLevel(val)
        else if (key === 'TELEGRAM_ENABLED') setEnabled(val === 'true')
      }
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
  const [activeTab, setActiveTab] = useState<ActiveTab>('file')
  const [activeFile, setActiveFile] = useState('.slashbotrc')
  const [content, setContent] = useState('')
  const [saved, setSaved] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    if (activeTab !== 'file') return
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
        {activeTab === 'file' && (
          <div className="header-actions">
            <button className="btn btn-primary" onClick={save} disabled={saved}>
              {saved ? 'Saved' : 'Save'}
            </button>
          </div>
        )}
      </header>
      <div className="config-tabs">
        {EDITABLE_FILES.map(f => (
          <button key={f.path} className={`tab ${activeTab === 'file' && activeFile === f.path ? 'active' : ''}`}
            onClick={() => { setActiveTab('file'); setActiveFile(f.path) }}>
            {f.label}
          </button>
        ))}
        <button
          className={`tab ${activeTab === 'telegram' ? 'active' : ''}`}
          onClick={() => setActiveTab('telegram')}
        >
          Telegram
        </button>
      </div>
      {activeTab === 'file' && (
        <>
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
    </div>
  )
}
