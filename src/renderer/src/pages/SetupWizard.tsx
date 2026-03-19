/**
 * SetupWizard — TypeScript/React replacement for ralph_enable.sh.
 *
 * Guides the user through enabling Ralph in a project:
 *   Step 1 → Project info (auto-detected)
 *   Step 2 → Task source (manual / beads)
 *   Step 3 → Confirm & generate files
 *   Step 4 → Done
 */
import React, { useCallback, useEffect, useState } from 'react'

type ProjectType = 'nodejs' | 'python' | 'rust' | 'go' | 'java' | 'ruby' | 'php' | 'unknown'

interface ProjectContext {
  type: ProjectType; name: string; hasGit: boolean; hasBeads: boolean
  installCmd: string; testCmd: string; buildCmd: string
}

interface EnabledStatus {
  enabled: boolean; missing: string[]
  hasRalphrc: boolean; hasRalphDir: boolean
  context: ProjectContext
}

interface EnableOptions {
  force: boolean; maxCallsPerHour: number
  useBeads: boolean; initialTasks: string[]
}

const TYPE_LABELS: Record<ProjectType, string> = {
  nodejs: 'Node.js', python: 'Python', rust: 'Rust', go: 'Go',
  java: 'Java', ruby: 'Ruby', php: 'PHP', unknown: 'Unknown'
}
const TYPE_ICONS: Record<ProjectType, string> = {
  nodejs: '⬡', python: '🐍', rust: '⚙', go: '🔵',
  java: '☕', ruby: '💎', php: '🐘', unknown: '📦'
}

interface Props {
  projectPath: string
  onComplete: () => void
}

type Step = 'check' | 'info' | 'confirm' | 'done' | 'already-enabled'

export default function SetupWizard({ projectPath, onComplete }: Props): JSX.Element {
  const [step,    setStep]    = useState<Step>('check')
  const [status,  setStatus]  = useState<EnabledStatus | null>(null)
  const [opts,    setOpts]    = useState<EnableOptions>({
    force: false, maxCallsPerHour: 100, useBeads: false, initialTasks: []
  })
  const [installing, setInstalling] = useState(false)
  const [result,     setResult]     = useState<{ filesCreated: string[] } | null>(null)
  const [error,      setError]      = useState<string | null>(null)

  // Check enabled status on mount
  useEffect(() => {
    window.ralph.isEnabled(projectPath).then((s: EnabledStatus) => {
      setStatus(s)
      setOpts(o => ({ ...o, useBeads: s.context.hasBeads }))
      setStep(s.enabled ? 'already-enabled' : 'info')
    })
  }, [projectPath])

  const handleEnable = useCallback(async (force = false) => {
    setInstalling(true)
    setError(null)
    const finalOpts = { ...opts, force, initialTasks: [] }
    const r = await window.ralph.enable(projectPath, finalOpts) as {
      ok: boolean; error?: string; filesCreated: string[]
    }
    setInstalling(false)
    if (r.ok) { setResult(r); setStep('done') }
    else setError(r.error ?? 'Unknown error')
  }, [projectPath, opts])

  const ctx = status?.context

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <div style={{ flex: 1, overflowY: 'auto' }}>
      <div className="page-header">
        <div>
          <div className="page-title">✦ Setup Ralph</div>
          <div className="page-sub">{projectPath}</div>
        </div>
      </div>

      <div style={{ maxWidth: 560, margin: '0 auto', padding: '32px 24px' }}>

        {/* ── Checking ── */}
        {step === 'check' && (
          <div className="state-box">
            <span className="spinner" />
            <div className="state-desc">Detecting project…</div>
          </div>
        )}

        {/* ── Already enabled ── */}
        {step === 'already-enabled' && (
          <div>
            <div style={{ marginBottom: 24 }}>
              <div style={{ fontSize: 32, marginBottom: 12 }}>✓</div>
              <div style={{ fontSize: 18, fontWeight: 700, color: 'var(--green)', marginBottom: 8 }}>
                Ralph is already enabled
              </div>
              <div style={{ color: 'var(--muted)', fontSize: 13 }}>
                This project has a complete Ralph setup. You can start the loop from the Dashboard.
              </div>
            </div>

            {ctx && (
              <div className="stat-card" style={{ marginBottom: 20 }}>
                <div className="stat-label">Project</div>
                <div style={{ marginTop: 8, fontSize: 18 }}>
                  {TYPE_ICONS[ctx.type]} {ctx.name}
                  <span style={{ fontSize: 12, color: 'var(--muted)', marginLeft: 8 }}>{TYPE_LABELS[ctx.type]}</span>
                </div>
              </div>
            )}

            <div style={{ display: 'flex', gap: 10 }}>
              <button className="btn btn-primary" onClick={onComplete}>Go to Dashboard</button>
              <button className="btn btn-ghost" onClick={() => setStep('info')}>Re-configure (force)</button>
            </div>
          </div>
        )}

        {/* ── Step 1: Project info ── */}
        {step === 'info' && ctx && (
          <div>
            <StepIndicator current={1} total={2} />
            <h2 style={{ marginBottom: 8 }}>Project detected</h2>
            <p style={{ color: 'var(--muted)', marginBottom: 24, fontSize: 13 }}>
              Ralph identified your project type. Review and continue.
            </p>

            <div className="stat-card" style={{ marginBottom: 16 }}>
              <div className="stat-label">Type</div>
              <div style={{ marginTop: 8, fontSize: 20 }}>
                {TYPE_ICONS[ctx.type]} {TYPE_LABELS[ctx.type]}
              </div>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 20 }}>
              <Field label="Git repository" value={ctx.hasGit ? '✓ Yes' : '✗ No'} ok={ctx.hasGit} />
              <Field label="Beads available" value={ctx.hasBeads ? '✓ Yes' : 'Not found'} ok={ctx.hasBeads} />
            </div>

            <div style={{ marginBottom: 20 }}>
              <label style={{ fontSize: 12, color: 'var(--muted)', fontWeight: 600, display: 'block', marginBottom: 6 }}>
                MAX CALLS PER HOUR
              </label>
              <input
                type="number" min={1} max={1000}
                value={opts.maxCallsPerHour}
                onChange={e => setOpts(o => ({ ...o, maxCallsPerHour: Number(e.target.value) }))}
                style={{ ...inputStyle, width: 100 }}
              />
              <span style={{ fontSize: 12, color: 'var(--muted)', marginLeft: 8 }}>Claude API calls per hour</span>
            </div>

            <div style={{ display: 'flex', gap: 10 }}>
              <button className="btn btn-primary" onClick={() => setStep('confirm')}>Continue →</button>
            </div>
          </div>
        )}

        {/* ── Step 2: Confirm ── */}
        {step === 'confirm' && ctx && (
          <div>
            <StepIndicator current={2} total={2} />
            <h2 style={{ marginBottom: 8 }}>Ready to enable Ralph</h2>
            <p style={{ color: 'var(--muted)', marginBottom: 20, fontSize: 13 }}>
              The following files will be created in your project:
            </p>

            <div style={{ marginBottom: 20 }}>
              {['.ralphrc', '.ralph/', '.ralph/PROMPT.md', '.ralph/AGENT.md'].map(f => (
                <div key={f} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '6px 0', borderBottom: '1px solid var(--border)' }}>
                  <span style={{ color: 'var(--green)', fontSize: 13 }}>+</span>
                  <span style={{ fontFamily: 'monospace', fontSize: 12 }}>{f}</span>
                </div>
              ))}
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '6px 0' }}>
                <span style={{ color: 'var(--blue)', fontSize: 13 }}>~</span>
                <span style={{ fontFamily: 'monospace', fontSize: 12 }}>.gitignore</span>
                <span style={{ fontSize: 11, color: 'var(--muted)' }}>(Ralph section appended)</span>
              </div>
            </div>

            {error && (
              <div style={{ padding: '10px 14px', background: '#450a0a', borderRadius: 6, color: 'var(--red)', fontSize: 13, marginBottom: 16 }}>
                {error}
              </div>
            )}

            <div style={{ display: 'flex', gap: 10 }}>
              <button className="btn btn-ghost" onClick={() => setStep('info')}>← Back</button>
              <button className="btn btn-primary" onClick={() => handleEnable(false)} disabled={installing}>
                {installing ? <><span className="spinner" style={{ width: 12, height: 12 }} /> Enabling…</> : '✦ Enable Ralph'}
              </button>
            </div>
          </div>
        )}

        {/* ── Done ── */}
        {step === 'done' && result && (
          <div>
            <div style={{ fontSize: 40, marginBottom: 16 }}>✓</div>
            <div style={{ fontSize: 20, fontWeight: 700, color: 'var(--green)', marginBottom: 8 }}>
              Ralph enabled!
            </div>
            <div style={{ color: 'var(--muted)', fontSize: 13, marginBottom: 24 }}>
              {result.filesCreated.length} file{result.filesCreated.length !== 1 ? 's' : ''} created.
            </div>

            <div style={{ marginBottom: 24 }}>
              {result.filesCreated.map(f => (
                <div key={f} style={{ display: 'flex', gap: 10, padding: '5px 0', fontFamily: 'monospace', fontSize: 12 }}>
                  <span style={{ color: 'var(--green)' }}>✓</span> {f}
                </div>
              ))}
            </div>

            <div style={{ color: 'var(--muted)', fontSize: 13, marginBottom: 24 }}>
              Next: go to the <strong>Plan</strong> tab to describe what you want built, then use the <strong>Swarm</strong> tab to start workers.
            </div>

            <button className="btn btn-primary" onClick={onComplete}>
              Go to Dashboard →
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

// ── Small helpers ─────────────────────────────────────────────────────────────

function StepIndicator({ current, total }: { current: number; total: number }): JSX.Element {
  return (
    <div style={{ display: 'flex', gap: 6, marginBottom: 24 }}>
      {Array.from({ length: total }, (_, i) => (
        <div key={i} style={{
          height: 3, flex: 1, borderRadius: 99,
          background: i < current ? 'var(--accent)' : 'var(--border)'
        }} />
      ))}
    </div>
  )
}

function Field({ label, value, ok }: { label: string; value: string; ok: boolean }): JSX.Element {
  return (
    <div className="stat-card">
      <div className="stat-label">{label}</div>
      <div style={{ marginTop: 6, fontSize: 14, color: ok ? 'var(--green)' : 'var(--muted)' }}>{value}</div>
    </div>
  )
}

const inputStyle: React.CSSProperties = {
  padding: '8px 12px', borderRadius: 6,
  border: '1px solid var(--border)', background: 'var(--surface2)',
  color: 'var(--text)', fontSize: 13, outline: 'none'
}
