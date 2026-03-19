import React, { useState, useCallback } from 'react'

const ralph = window.ralph

interface Props {
  projectPath: string
  onComplete: () => void
}

export default function SetupWizard({ projectPath, onComplete }: Props) {
  const [step, setStep] = useState(0)
  const [maxCalls, setMaxCalls] = useState(100)
  const [useBeads, setUseBeads] = useState(true)
  const [running, setRunning] = useState(false)
  const [result, setResult] = useState<any>(null)

  const run = useCallback(async () => {
    setRunning(true)
    const r = await ralph.enable(projectPath, {
      force: true,
      maxCallsPerHour: maxCalls,
      useBeads,
      initialTasks: []
    })
    setResult(r)
    setRunning(false)
    if (r.ok) setTimeout(onComplete, 1500)
  }, [projectPath, maxCalls, useBeads, onComplete])

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
            <button className="btn btn-primary btn-lg" onClick={() => setStep(1)}>
              Continue
            </button>
          </div>
        )}

        {step === 1 && (
          <div className="setup-step animate-fade-in">
            <h3>Ready to initialize</h3>
            <p>This will create:</p>
            <ul className="setup-files">
              <li><code>.ralphrc</code> - Configuration</li>
              <li><code>.ralph/PROMPT.md</code> - AI instructions</li>
              <li><code>.ralph/AGENT.md</code> - Build commands</li>
            </ul>
            <div className="setup-actions">
              <button className="btn btn-ghost" onClick={() => setStep(0)}>Back</button>
              <button className="btn btn-primary btn-lg" onClick={run} disabled={running}>
                {running ? 'Setting up...' : 'Initialize'}
              </button>
            </div>
            {result?.ok && (
              <div className="alert alert-success animate-fade-in mt-2">
                Project initialized! Created {result.filesCreated.length} files.
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
