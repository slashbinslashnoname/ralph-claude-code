import React, { useState, useCallback, useEffect } from 'react'

type EnableResult = Awaited<ReturnType<typeof window.slashbot.enable>>

const sb = window.slashbot

interface Props {
  projectPath: string
  onComplete: () => void
}

export default function SetupWizard({ projectPath, onComplete }: Props) {
  const [step, setStep] = useState(0)
  const [maxCalls, setMaxCalls] = useState(100)
  const [useBeads, setUseBeads] = useState(true)
  const [running, setRunning] = useState(false)
  const [result, setResult] = useState<EnableResult | null>(null)
  const [bdInstalled, setBdInstalled] = useState<boolean | null>(null)
  const [bdChecking, setBdChecking] = useState(false)

  // Check bd installation status when useBeads is toggled on
  useEffect(() => {
    if (!useBeads) { setBdInstalled(null); return }
    let cancelled = false
    setBdChecking(true)
    sb.beads.installCheck().then(r => {
      if (!cancelled) { setBdInstalled(r.installed); setBdChecking(false) }
    })
    return () => { cancelled = true }
  }, [useBeads])

  const run = useCallback(async () => {
    setRunning(true)
    const r = await sb.enable(projectPath, {
      force: true,
      maxCallsPerHour: maxCalls,
      useBeads,
      initialTasks: []
    })
    setResult(r)
    setRunning(false)
    if (r.ok) setTimeout(onComplete, 1500)
  }, [projectPath, maxCalls, useBeads, onComplete])

  const canContinue = !useBeads || bdInstalled === true

  return (
    <div className="page setup-page">
      <div className="setup-card">
        <div className="setup-header">
          <span className="setup-icon">{'\u2699'}</span>
          <h2>Setup Project</h2>
          <p className="setup-path">{projectPath}</p>
        </div>

        {step === 0 && (
          <div className="setup-step animate-fade-in">
            <h3>Configuration</h3>
            <div className="form-group">
              <label>Max API calls per hour</label>
              <input type="number" className="input" value={maxCalls}
                onChange={e => setMaxCalls(Number(e.target.value))} min={10} max={500} />
            </div>
            <div className="form-group">
              <label className="toggle-label">
                <input type="checkbox" checked={useBeads} onChange={e => setUseBeads(e.target.checked)} />
                Use beads (bd CLI) for task management
              </label>
            </div>

            {useBeads && bdChecking && (
              <div className="alert alert-info animate-fade-in mt-1">
                Checking bd CLI...
              </div>
            )}

            {useBeads && bdInstalled === false && (
              <div className="alert alert-warning animate-fade-in mt-1">
                <p><strong>bd CLI not found.</strong> Install it first:</p>
                <div className="install-options">
                  <code className="install-cmd">brew install beads-rust</code>
                  <span className="install-or">or</span>
                  <code className="install-cmd">cargo install beads-rust</code>
                </div>
                <p className="mt-1" style={{ fontSize: '0.85em', opacity: 0.8 }}>
                  After installing, click "Re-check" below.
                </p>
                <button className="btn btn-ghost btn-sm mt-1" onClick={() => {
                  setBdChecking(true)
                  sb.beads.installCheck().then(r => { setBdInstalled(r.installed); setBdChecking(false) })
                }}>
                  Re-check
                </button>
              </div>
            )}

            {useBeads && bdInstalled === true && (
              <div className="alert alert-success animate-fade-in mt-1">
                bd CLI detected. Beads will be initialized automatically.
              </div>
            )}

            <button className="btn btn-primary btn-lg" onClick={() => setStep(1)} disabled={!canContinue}>
              Continue
            </button>
          </div>
        )}

        {step === 1 && (
          <div className="setup-step animate-fade-in">
            <h3>Ready to initialize</h3>
            <p>This will create:</p>
            <ul className="setup-files">
              <li><code>.slashbotid</code> - Project identifier</li>
              <li><code>~/.slashbot/projects/&lt;id&gt;/</code> - Centralized storage</li>
              <li><code>.slashbotrc</code> - Configuration</li>
              <li><code>PROMPT.md</code> - AI instructions</li>
              <li><code>AGENT.md</code> - Build commands</li>
              {useBeads && <li><code>.beads/</code> - Beads task tracking</li>}
            </ul>
            <div className="setup-actions">
              <button className="btn btn-ghost" onClick={() => setStep(0)}>Back</button>
              <button className="btn btn-primary btn-lg" onClick={run} disabled={running}>
                {running ? 'Setting up...' : 'Initialize'}
              </button>
            </div>
            {result?.ok && (
              <div className="alert alert-success animate-fade-in mt-2">
                <p>Project initialized! Created {result.filesCreated.length} files.</p>
                {result.storeDir && (
                  <p className="store-dir-info">
                    Storage: <code>{result.storeDir}</code>
                  </p>
                )}
              </div>
            )}
            {result && !result.ok && (
              <div className="alert alert-danger animate-fade-in mt-2">
                Error: {result.error}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
