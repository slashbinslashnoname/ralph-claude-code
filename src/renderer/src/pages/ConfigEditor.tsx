import React, { useState, useEffect, useCallback } from 'react'
import { AsyncButton } from '../components/AsyncButton'
import { useToast } from '../components/Toast'
import type { UpdateState, UpdateInfo, UpdateProgress, RalphConfig } from '../types/ipc'

const sb = window.slashbot

interface Props { projectPath: string }

type ActiveTab = 'settings' | 'prompts' | 'telegram' | 'updates'

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

// Inline validation ranges — mirrors NUMERIC_RANGES from RcParser.ts
const NUMERIC_RANGES: Partial<Record<keyof RalphConfig, { min: number; max: number }>> = {
  maxCallsPerHour: { min: 1, max: 10000 },
  claudeTimeoutMinutes: { min: 1, max: 1440 },
  sleepDuration: { min: 0, max: 3600 },
  cbNoProgressThreshold: { min: 1, max: 1000 },
  cbSameErrorThreshold: { min: 1, max: 1000 },
  cbErrorWindowSize: { min: 1, max: 1000 },
  cbErrorWindowThreshold: { min: 1, max: 1000 },
  cbPermissionDenialThreshold: { min: 1, max: 1000 },
  cbCooldownMinutes: { min: 1, max: 1440 },
  cbMaxCooldownMinutes: { min: 1, max: 1440 },
  maxRetries: { min: 0, max: 10 },
  autoSplitThreshold: { min: 1, max: 100 },
  buildMonitorInterval: { min: 30, max: 86400 },
}

const OUTPUT_FORMATS = [
  { value: 'json', label: 'JSON' },
  { value: 'text', label: 'Text' },
] as const

// ---------------------------------------------------------------------------
// Validation helper
// ---------------------------------------------------------------------------

function validateField(key: keyof RalphConfig, value: string | number | boolean): string | null {
  const range = NUMERIC_RANGES[key]
  if (range && typeof value === 'number') {
    if (isNaN(value)) return 'Must be a number'
    if (value < range.min || value > range.max) return `Must be between ${range.min} and ${range.max}`
  }
  return null
}

// ---------------------------------------------------------------------------
// Reusable form field components
// ---------------------------------------------------------------------------

interface NumberFieldProps {
  label: string
  configKey: keyof RalphConfig
  value: number
  onChange: (key: keyof RalphConfig, value: number) => void
  errors: Record<string, string | null>
}

function NumberField({ label, configKey, value, onChange, errors }: NumberFieldProps) {
  const range = NUMERIC_RANGES[configKey]
  const error = errors[configKey]
  return (
    <div className="form-group">
      <label>{label}</label>
      <input
        type="number"
        className={`input ${error ? 'input-error' : ''}`}
        value={value}
        min={range?.min}
        max={range?.max}
        onChange={e => onChange(configKey, Number(e.target.value))}
      />
      {error && <span className="field-error">{error}</span>}
      {range && !error && <span className="field-hint">{range.min}–{range.max}</span>}
    </div>
  )
}

interface TextFieldProps {
  label: string
  configKey: keyof RalphConfig
  value: string
  onChange: (key: keyof RalphConfig, value: string) => void
}

function TextField({ label, configKey, value, onChange }: TextFieldProps) {
  return (
    <div className="form-group">
      <label>{label}</label>
      <input
        type="text"
        className="input"
        value={value}
        onChange={e => onChange(configKey, e.target.value)}
      />
    </div>
  )
}

interface CheckboxFieldProps {
  label: string
  configKey: keyof RalphConfig
  checked: boolean
  onChange: (key: keyof RalphConfig, value: boolean) => void
}

function CheckboxField({ label, configKey, checked, onChange }: CheckboxFieldProps) {
  return (
    <label className="toggle-label">
      <input
        type="checkbox"
        checked={checked}
        onChange={e => onChange(configKey, e.target.checked)}
      />
      {label}
    </label>
  )
}

// ---------------------------------------------------------------------------
// SettingsSection — structured form for .slashbotrc
// ---------------------------------------------------------------------------

function SettingsSection({ projectPath }: { projectPath: string }) {
  const { showToast } = useToast()
  const [config, setConfig] = useState<RalphConfig | null>(null)
  const [errors, setErrors] = useState<Record<string, string | null>>({})
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)

  // Load config on mount
  useEffect(() => {
    setLoading(true)
    setLoadError(null)
    sb.config.read(projectPath).then(r => {
      if (r.ok && r.config) {
        setConfig(r.config)
      } else {
        setLoadError(r.error ?? 'Failed to load configuration')
      }
      setLoading(false)
    })
  }, [projectPath])

  const handleChange = useCallback((key: keyof RalphConfig, value: string | number | boolean) => {
    if (!config) return
    const err = validateField(key, value)
    setErrors(prev => ({ ...prev, [key]: err }))
    setConfig(prev => prev ? { ...prev, [key]: value } : prev)
  }, [config])

  const hasErrors = Object.values(errors).some(e => e != null)

  const handleSave = useCallback(async () => {
    if (!config || hasErrors) return
    const { telegram: _tg, ...updates } = config
    const r = await sb.config.write(projectPath, updates)
    if (r.ok) {
      showToast('Configuration saved.', { variant: 'success' })
    } else {
      throw new Error(r.error ?? 'Save failed')
    }
  }, [config, hasErrors, projectPath, showToast])

  if (loading) return <div className="settings-loading">Loading configuration...</div>
  if (loadError) return <div className="alert alert-danger">{loadError}</div>
  if (!config) return null

  return (
    <div className="settings-form">
      {/* Execution */}
      <fieldset className="settings-section">
        <legend>Execution</legend>
        <div className="settings-grid">
          <NumberField label="Max calls / hour" configKey="maxCallsPerHour" value={config.maxCallsPerHour} onChange={handleChange} errors={errors} />
          <NumberField label="Claude timeout (min)" configKey="claudeTimeoutMinutes" value={config.claudeTimeoutMinutes} onChange={handleChange} errors={errors} />
          <NumberField label="Sleep duration (s)" configKey="sleepDuration" value={config.sleepDuration} onChange={handleChange} errors={errors} />
          <NumberField label="Max retries" configKey="maxRetries" value={config.maxRetries} onChange={handleChange} errors={errors} />
          <NumberField label="Auto-split threshold" configKey="autoSplitThreshold" value={config.autoSplitThreshold} onChange={handleChange} errors={errors} />
        </div>
        <div className="settings-checkboxes">
          <CheckboxField label="Continue session" configKey="continueSession" checked={config.continueSession} onChange={handleChange} />
          <CheckboxField label="Auto push" configKey="autoPush" checked={config.autoPush} onChange={handleChange} />
        </div>
      </fieldset>

      {/* Claude CLI */}
      <fieldset className="settings-section">
        <legend>Claude CLI</legend>
        <div className="settings-grid">
          <TextField label="Claude command" configKey="claudeCodeCmd" value={config.claudeCodeCmd} onChange={handleChange} />
          <TextField label="Allowed tools" configKey="allowedTools" value={config.allowedTools} onChange={handleChange} />
          <div className="form-group">
            <label>Output format</label>
            <select
              className="select"
              value={config.claudeOutputFormat}
              onChange={e => handleChange('claudeOutputFormat', e.target.value)}
            >
              {OUTPUT_FORMATS.map(f => (
                <option key={f.value} value={f.value}>{f.label}</option>
              ))}
            </select>
          </div>
        </div>
      </fieldset>

      {/* Model Routing */}
      <fieldset className="settings-section">
        <legend>Model Routing</legend>
        <div className="settings-grid">
          <TextField label="Think model" configKey="claudeModelThink" value={config.claudeModelThink} onChange={handleChange} />
          <TextField label="Execute model" configKey="claudeModelExecute" value={config.claudeModelExecute} onChange={handleChange} />
          <TextField label="Review model" configKey="claudeModelReview" value={config.claudeModelReview} onChange={handleChange} />
        </div>
      </fieldset>

      {/* Circuit Breaker */}
      <fieldset className="settings-section">
        <legend>Circuit Breaker</legend>
        <div className="settings-grid">
          <NumberField label="No-progress threshold" configKey="cbNoProgressThreshold" value={config.cbNoProgressThreshold} onChange={handleChange} errors={errors} />
          <NumberField label="Same-error threshold" configKey="cbSameErrorThreshold" value={config.cbSameErrorThreshold} onChange={handleChange} errors={errors} />
          <NumberField label="Error window size" configKey="cbErrorWindowSize" value={config.cbErrorWindowSize} onChange={handleChange} errors={errors} />
          <NumberField label="Error window threshold" configKey="cbErrorWindowThreshold" value={config.cbErrorWindowThreshold} onChange={handleChange} errors={errors} />
          <NumberField label="Permission denial threshold" configKey="cbPermissionDenialThreshold" value={config.cbPermissionDenialThreshold} onChange={handleChange} errors={errors} />
          <NumberField label="Cooldown (min)" configKey="cbCooldownMinutes" value={config.cbCooldownMinutes} onChange={handleChange} errors={errors} />
          <NumberField label="Max cooldown (min)" configKey="cbMaxCooldownMinutes" value={config.cbMaxCooldownMinutes} onChange={handleChange} errors={errors} />
        </div>
      </fieldset>

      {/* Build Monitor */}
      <fieldset className="settings-section">
        <legend>Build Monitor</legend>
        <div className="settings-grid">
          <TextField label="Build command" configKey="buildMonitorCmd" value={config.buildMonitorCmd} onChange={handleChange} />
          <NumberField label="Interval (s)" configKey="buildMonitorInterval" value={config.buildMonitorInterval} onChange={handleChange} errors={errors} />
        </div>
      </fieldset>

      {/* Save */}
      <div className="form-actions" style={{ marginTop: 16 }}>
        <AsyncButton className="btn-primary" onClick={handleSave} disabled={hasErrors}
          pendingContent="Saving\u2026">Save Settings</AsyncButton>
      </div>
    </div>
  )
}

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
      case 'error': return 'An error occurred while checking for updates.'
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
  const { showToast } = useToast()
  const [botToken, setBotToken] = useState('')
  const [chatId, setChatId] = useState('')
  const [notifyLevel, setNotifyLevel] = useState('errors')
  const [enabled, setEnabled] = useState(false)
  const [status, setStatus] = useState<TelegramStatus | null>(null)

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
    if (enabled && botToken && chatId) {
      const r = await sb.telegram.configure(projectPath, { botToken, chatId, notifyLevel })
      if (!r.ok) throw new Error(r.error ?? 'Save failed')
      await loadStatus()
      showToast('Telegram configuration saved.', { variant: 'success' })
    } else if (!enabled && status?.connected) {
      await sb.telegram.disconnect(projectPath)
      await loadStatus()
      showToast('Telegram disconnected.', { variant: 'success' })
    }
  }, [projectPath, botToken, chatId, notifyLevel, enabled, status, loadStatus, showToast])

  const handleTest = useCallback(async () => {
    const r = await sb.telegram.test(projectPath)
    if (!r.ok) throw new Error(r.error ?? 'Test failed')
    showToast('Test message sent successfully!', { variant: 'success' })
  }, [projectPath, showToast])

  const handleDisconnect = useCallback(async () => {
    await sb.telegram.disconnect(projectPath)
    setEnabled(false)
    await loadStatus()
    showToast('Telegram disconnected.', { variant: 'info' })
  }, [projectPath, loadStatus, showToast])

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
        <AsyncButton className="btn-primary" onClick={handleSave}
          disabled={(!botToken && enabled) || (!chatId && enabled)}
          pendingContent="Saving\u2026">Save</AsyncButton>
        <AsyncButton className="btn-ghost" onClick={handleTest}
          disabled={!connected}
          pendingContent="Testing\u2026">Test Connection</AsyncButton>
        {connected && (
          <AsyncButton className="btn-danger" onClick={handleDisconnect}
            pendingContent="Disconnecting\u2026">Disconnect</AsyncButton>
        )}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// ConfigEditor (main component)
// ---------------------------------------------------------------------------

export default function ConfigEditor({ projectPath }: Props) {
  const { showToast } = useToast()
  const [activeTab, setActiveTab] = useState<ActiveTab>('settings')
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
    if (r.ok) { setSaved(true); setError(''); showToast('File saved.', { variant: 'success' }) }
    else throw new Error(r.error ?? 'Failed to save')
  }, [projectPath, activeFile, content, showToast])

  return (
    <div className="page">
      <header className="page-header">
        <h2>Configuration</h2>
        {activeTab === 'prompts' && (
          <div className="header-actions">
            <AsyncButton className="btn-primary" onClick={save} disabled={saved}
              pendingContent="Saving\u2026">
              {saved ? 'Saved' : 'Save'}
            </AsyncButton>
          </div>
        )}
      </header>
      <div className="config-tabs">
        <button
          className={`tab ${activeTab === 'settings' ? 'active' : ''}`}
          onClick={() => setActiveTab('settings')}
        >
          Settings
        </button>
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
      {activeTab === 'settings' && <SettingsSection projectPath={projectPath} />}
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

// Export for testing
export { SettingsSection, NumberField, CheckboxField, TextField, validateField, NUMERIC_RANGES }
