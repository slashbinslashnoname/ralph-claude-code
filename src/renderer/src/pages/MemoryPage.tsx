import React, { useState, useEffect, useCallback } from 'react'
import type { SmRule, SmRuleDetail, SmStatusResult, SmProject, SmDistillResult } from '../types/ipc'

const sb = window.slashbot

interface Props { projectPath: string }

type Tab = 'context' | 'rules' | 'ingest' | 'projects'

export default function MemoryPage({ projectPath }: Props) {
  const [smInstalled, setSmInstalled] = useState<boolean | null>(null)
  const [tab, setTab] = useState<Tab>('context')
  const [status, setStatus] = useState<SmStatusResult | null>(null)

  useEffect(() => {
    sb.memory.smCheck().then(r => {
      setSmInstalled(r.installed)
      if (r.installed) {
        sb.memory.smStatus(projectPath).then(s => { if (s.ok && s.data) setStatus(s.data) })
      }
    })
  }, [projectPath])

  if (smInstalled === null) return <div className="page"><p className="text-muted">Loading...</p></div>

  if (!smInstalled) {
    return (
      <div className="page">
        <header className="page-header"><h2>Memory</h2></header>
        <div className="empty-state">
          <p>Slashmem is not installed.</p>
          <p>Install <code>sm</code> to enable agent memory:</p>
          <pre>cargo install slashmem</pre>
        </div>
      </div>
    )
  }

  const TABS: { id: Tab; label: string }[] = [
    { id: 'context', label: 'Context' },
    { id: 'rules', label: 'Rules' },
    { id: 'ingest', label: 'Ingest' },
    { id: 'projects', label: 'Projects' },
  ]

  return (
    <div className="page">
      <header className="page-header">
        <h2>Memory</h2>
        {status && <StatusBar status={status} projectPath={projectPath} onRefresh={s => setStatus(s)} />}
      </header>

      <div className="mem-tabs">
        {TABS.map(t => (
          <button
            key={t.id}
            className={`mem-tab ${tab === t.id ? 'mem-tab-active' : ''}`}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'context' && <ContextTab projectPath={projectPath} />}
      {tab === 'rules' && <RulesTab projectPath={projectPath} />}
      {tab === 'ingest' && <IngestTab projectPath={projectPath} />}
      {tab === 'projects' && <ProjectsTab />}
    </div>
  )
}

/* ── Status Bar ────────────────────────────────────────────────────────────── */

function StatusBar({ status, projectPath, onRefresh }: {
  status: SmStatusResult
  projectPath: string
  onRefresh: (s: SmStatusResult) => void
}) {
  const [distilling, setDistilling] = useState(false)
  const [distillResult, setDistillResult] = useState<SmDistillResult | null>(null)

  const runDistill = useCallback(async () => {
    setDistilling(true)
    setDistillResult(null)
    try {
      const r = await sb.memory.smDistill(projectPath)
      if (r.ok && r.data) {
        setDistillResult(r.data)
        const s = await sb.memory.smStatus(projectPath)
        if (s.ok && s.data) onRefresh(s.data)
      }
    } finally {
      setDistilling(false)
    }
  }, [projectPath, onRefresh])

  return (
    <div className="mem-status-bar">
      <div className="mem-status-counts">
        <span className="mem-stat" title="Procedural rules">
          <span className="mem-stat-n">{status.counts.procedural}</span> rules
        </span>
        <span className="mem-stat-sep" />
        <span className="mem-stat" title="Episodic records">
          <span className="mem-stat-n">{status.counts.episodic}</span> episodes
        </span>
        <span className="mem-stat-sep" />
        <span className="mem-stat" title="Working memory entries">
          <span className="mem-stat-n">{status.counts.working}</span> working
        </span>
      </div>
      <button
        className="btn btn-ghost mem-distill-btn"
        onClick={runDistill}
        disabled={distilling}
        title="Run confidence decay, transitions, and pruning"
      >
        {distilling ? 'Distilling...' : 'Distill'}
      </button>
      {distillResult && (
        <span className="mem-distill-result">
          {distillResult.decayed} decayed, {distillResult.pruned} pruned, {distillResult.transitioned} transitioned
        </span>
      )}
    </div>
  )
}

/* ── Context Tab ───────────────────────────────────────────────────────────── */

function ContextTab({ projectPath }: { projectPath: string }) {
  const [query, setQuery] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [hasSearched, setHasSearched] = useState(false)
  const [executionMs, setExecutionMs] = useState<number | null>(null)

  const [rules, setRules] = useState<SmRule[]>([])
  const [antiPatterns, setAntiPatterns] = useState<SmRule[]>([])
  const [snippets, setSnippets] = useState<string[]>([])

  const clearResults = useCallback(() => {
    setRules([]); setAntiPatterns([]); setSnippets([])
    setError(null); setExecutionMs(null)
  }, [])

  const search = useCallback(async () => {
    if (!query.trim()) return
    setLoading(true); clearResults(); setHasSearched(true)
    const t0 = Date.now()
    try {
      const r = await sb.memory.smContext(projectPath, query.trim())
      if (!r.ok) { setError(r.error ?? 'Unknown error'); return }
      const d = r.data!
      setRules(d.relevant_rules ?? [])
      setAntiPatterns(d.anti_patterns ?? [])
      setSnippets(d.history_snippets ?? [])
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setExecutionMs(Date.now() - t0)
      setLoading(false)
    }
  }, [query, projectPath, clearResults])

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); search() }
  }, [search])

  const totalResults = rules.length + antiPatterns.length + snippets.length

  return (
    <div className="mem-context-tab">
      <div className="mem-search-row">
        <input
          type="text"
          className="input mem-search-input"
          placeholder="Describe a task to retrieve relevant memory..."
          value={query}
          onChange={e => setQuery(e.target.value)}
          onKeyDown={handleKeyDown}
          disabled={loading}
        />
        <button className="btn btn-primary" onClick={search} disabled={loading || !query.trim()}>
          {loading ? 'Searching...' : 'Search'}
        </button>
      </div>

      {error && <div className="memory-error"><strong>Error:</strong> {error}</div>}

      {hasSearched && !loading && !error && executionMs != null && (
        <div className="mem-timing">{totalResults} result{totalResults !== 1 ? 's' : ''} in {executionMs}ms</div>
      )}

      {hasSearched && !loading && !error && totalResults === 0 && (
        <div className="empty-state"><p>No results for &quot;{query}&quot;</p></div>
      )}

      <div className="memory-results">
        {rules.length > 0 && (
          <ResultSection title="Relevant Rules" count={rules.length}>
            {rules.map(r => <SmRuleCard key={r.id} rule={r} />)}
          </ResultSection>
        )}
        {antiPatterns.length > 0 && (
          <ResultSection title="Anti-Patterns" count={antiPatterns.length} variant="warning">
            {antiPatterns.map(r => <SmRuleCard key={r.id} rule={r} variant="warning" />)}
          </ResultSection>
        )}
        {snippets.length > 0 && (
          <ResultSection title="History Snippets" count={snippets.length}>
            {snippets.map((s, i) => (
              <div key={i} className="memory-bullet-card mem-snippet-card">
                <div className="memory-bullet-content">{s}</div>
              </div>
            ))}
          </ResultSection>
        )}
      </div>
    </div>
  )
}

/* ── Rules Tab ─────────────────────────────────────────────────────────────── */

function RulesTab({ projectPath }: { projectPath: string }) {
  const [rules, setRules] = useState<SmRuleDetail[]>([])
  const [loading, setLoading] = useState(true)
  const [filterQuery, setFilterQuery] = useState('')
  const [showAdd, setShowAdd] = useState(false)
  const [addId, setAddId] = useState('')
  const [addText, setAddText] = useState('')
  const [addSource, setAddSource] = useState('')
  const [adding, setAdding] = useState(false)
  const [expanded, setExpanded] = useState<string | null>(null)
  const [expandedDetail, setExpandedDetail] = useState<SmRuleDetail | null>(null)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async (q?: string) => {
    setLoading(true)
    try {
      const r = await sb.memory.smRulesList(projectPath, q || undefined)
      if (r.ok && r.data) setRules(r.data.rules)
      else setError(r.error ?? 'Failed to load rules')
    } finally {
      setLoading(false)
    }
  }, [projectPath])

  useEffect(() => { refresh() }, [refresh])

  const handleFilter = useCallback(() => {
    refresh(filterQuery.trim() || undefined)
  }, [refresh, filterQuery])

  const handleAdd = useCallback(async () => {
    if (!addId.trim() || !addText.trim()) return
    setAdding(true); setError(null)
    try {
      const r = await sb.memory.smRulesAdd(projectPath, addId.trim(), addText.trim(), addSource.trim() || undefined)
      if (r.ok) {
        setAddId(''); setAddText(''); setAddSource(''); setShowAdd(false)
        refresh()
      } else {
        setError(r.error ?? 'Failed to add rule')
      }
    } finally {
      setAdding(false)
    }
  }, [projectPath, addId, addText, addSource, refresh])

  const handleDelete = useCallback(async (ruleId: string) => {
    const r = await sb.memory.smRulesRm(projectPath, ruleId)
    if (r.ok) {
      setExpanded(null); setExpandedDetail(null)
      refresh()
    }
  }, [projectPath, refresh])

  const handleExpand = useCallback(async (ruleId: string) => {
    if (expanded === ruleId) { setExpanded(null); setExpandedDetail(null); return }
    setExpanded(ruleId)
    const r = await sb.memory.smRulesShow(projectPath, ruleId)
    if (r.ok && r.data) setExpandedDetail(r.data)
  }, [projectPath, expanded])

  return (
    <div className="mem-rules-tab">
      <div className="mem-rules-toolbar">
        <div className="mem-search-row">
          <input
            type="text"
            className="input mem-search-input"
            placeholder="Filter rules..."
            value={filterQuery}
            onChange={e => setFilterQuery(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') handleFilter() }}
          />
          <button className="btn btn-ghost" onClick={handleFilter}>Filter</button>
        </div>
        <button className="btn btn-primary" onClick={() => setShowAdd(!showAdd)}>
          {showAdd ? 'Cancel' : '+ Add Rule'}
        </button>
      </div>

      {error && <div className="memory-error"><strong>Error:</strong> {error}</div>}

      {showAdd && (
        <div className="mem-add-form">
          <div className="mem-add-row">
            <input
              type="text"
              className="input"
              placeholder="rule-id (kebab-case)"
              value={addId}
              onChange={e => setAddId(e.target.value)}
              style={{ flex: '0 0 200px' }}
            />
            <input
              type="text"
              className="input"
              placeholder="Source (optional)"
              value={addSource}
              onChange={e => setAddSource(e.target.value)}
              style={{ flex: '0 0 160px' }}
            />
          </div>
          <textarea
            className="input mem-add-textarea"
            placeholder="Rule text — what should agents remember?"
            value={addText}
            onChange={e => setAddText(e.target.value)}
            rows={3}
          />
          <button
            className="btn btn-primary"
            onClick={handleAdd}
            disabled={adding || !addId.trim() || !addText.trim()}
          >
            {adding ? 'Adding...' : 'Add Rule'}
          </button>
        </div>
      )}

      {loading ? (
        <div className="empty-state"><p>Loading rules...</p></div>
      ) : rules.length === 0 ? (
        <div className="empty-state">
          <p>No rules yet.</p>
          <p className="text-muted">Add rules manually or let agents learn them via <code>sm ingest</code>.</p>
        </div>
      ) : (
        <div className="mem-rules-list">
          {rules.map(rule => (
            <div key={rule.id} className={`mem-rule-row ${expanded === rule.id ? 'mem-rule-expanded' : ''}`}>
              <div className="mem-rule-summary" onClick={() => handleExpand(rule.id)}>
                <div className="mem-rule-left">
                  <span className="mem-rule-id">{rule.id}</span>
                  <span className="mem-rule-text">{rule.rule}</span>
                </div>
                <div className="mem-rule-right">
                  {rule.is_proven && <span className="mem-badge mem-badge-proven">proven</span>}
                  {rule.is_anti_pattern && <span className="mem-badge mem-badge-anti">anti-pattern</span>}
                  <ConfidenceBar value={rule.confidence} />
                  {(rule.success_count != null || rule.failure_count != null) && (
                    <span className="mem-rule-counts">
                      <span className="feedback-helpful">+{rule.success_count ?? 0}</span>
                      <span className="feedback-harmful">-{rule.failure_count ?? 0}</span>
                    </span>
                  )}
                </div>
              </div>

              {expanded === rule.id && expandedDetail && (
                <div className="mem-rule-detail">
                  <div className="mem-rule-detail-grid">
                    <DetailField label="Confidence" value={expandedDetail.confidence.toFixed(3)} />
                    <DetailField label="Successes" value={String(expandedDetail.success_count ?? 0)} />
                    <DetailField label="Failures" value={String(expandedDetail.failure_count ?? 0)} />
                    <DetailField label="Source" value={expandedDetail.source ?? '—'} />
                    <DetailField label="Last Validated" value={expandedDetail.last_validated ?? 'never'} />
                    <DetailField label="Created" value={expandedDetail.created_at ?? '—'} />
                  </div>
                  <div className="mem-rule-detail-text">{expandedDetail.rule}</div>
                  <button
                    className="btn btn-ghost mem-rule-delete"
                    onClick={() => handleDelete(rule.id)}
                  >
                    Delete Rule
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

/* ── Ingest Tab ────────────────────────────────────────────────────────────── */

function IngestTab({ projectPath }: { projectPath: string }) {
  const [task, setTask] = useState('')
  const [body, setBody] = useState('')
  const [agent, setAgent] = useState('user')
  const [successIds, setSuccessIds] = useState('')
  const [harmIds, setHarmIds] = useState('')
  const [loading, setLoading] = useState(false)
  const [result, setResult] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const handleSubmit = useCallback(async () => {
    if (!task.trim() || !body.trim()) return
    setLoading(true); setError(null); setResult(null)
    try {
      const sIds = successIds.trim() ? successIds.split(/[\s,]+/).filter(Boolean) : undefined
      const hIds = harmIds.trim() ? harmIds.split(/[\s,]+/).filter(Boolean) : undefined
      const r = await sb.memory.smIngest(projectPath, task.trim(), body.trim(), agent.trim(), sIds, hIds)
      if (r.ok) {
        setResult(`Episodic record #${r.data?.episodic_id} created`)
        setTask(''); setBody(''); setSuccessIds(''); setHarmIds('')
      } else {
        setError(r.error ?? 'Failed to ingest')
      }
    } finally {
      setLoading(false)
    }
  }, [projectPath, task, body, agent, successIds, harmIds])

  return (
    <div className="mem-ingest-tab">
      <p className="mem-ingest-desc">
        Record what happened during a task. Optionally reinforce or penalize rules.
      </p>

      <div className="mem-ingest-form">
        <div className="mem-ingest-row">
          <div className="mem-ingest-field">
            <label>Task ID *</label>
            <input type="text" className="input" placeholder="TASK-42" value={task} onChange={e => setTask(e.target.value)} />
          </div>
          <div className="mem-ingest-field">
            <label>Agent</label>
            <input type="text" className="input" placeholder="agent-0" value={agent} onChange={e => setAgent(e.target.value)} />
          </div>
        </div>

        <div className="mem-ingest-field">
          <label>Body *</label>
          <textarea
            className="input mem-add-textarea"
            placeholder="What happened and why..."
            value={body}
            onChange={e => setBody(e.target.value)}
            rows={4}
          />
        </div>

        <div className="mem-ingest-row">
          <div className="mem-ingest-field">
            <label>Reinforce rules (comma-separated IDs)</label>
            <input type="text" className="input" placeholder="rule-a, rule-b" value={successIds} onChange={e => setSuccessIds(e.target.value)} />
          </div>
          <div className="mem-ingest-field">
            <label>Penalize rules (comma-separated IDs)</label>
            <input type="text" className="input" placeholder="rule-c" value={harmIds} onChange={e => setHarmIds(e.target.value)} />
          </div>
        </div>

        <button className="btn btn-primary" onClick={handleSubmit} disabled={loading || !task.trim() || !body.trim()}>
          {loading ? 'Recording...' : 'Record Episode'}
        </button>

        {error && <div className="memory-error" style={{ marginTop: 8 }}><strong>Error:</strong> {error}</div>}
        {result && <div className="mem-success">{result}</div>}
      </div>
    </div>
  )
}

/* ── Projects Tab ──────────────────────────────────────────────────────────── */

interface ProjectGroup {
  name: string
  root: SmProject
  worktrees: SmProject[]
}

function groupProjects(projects: SmProject[]): ProjectGroup[] {
  const roots: SmProject[] = []
  const worktrees: SmProject[] = []
  for (const p of projects) {
    if (p.path.includes('.worktrees/')) worktrees.push(p)
    else roots.push(p)
  }

  return roots.map(root => {
    // Match worktrees whose path starts with root path + /.worktrees/
    const wts = worktrees.filter(w => w.path.startsWith(root.path + '/.worktrees/'))
    return { name: root.path.split('/').pop() || root.name, root, worktrees: wts }
  })
}

function ProjectsTab() {
  const [projects, setProjects] = useState<SmProject[]>([])
  const [loading, setLoading] = useState(true)
  const [expandedGroup, setExpandedGroup] = useState<string | null>(null)

  useEffect(() => {
    sb.memory.smProjects().then(r => {
      if (r.ok && r.data) setProjects(r.data.projects)
      setLoading(false)
    })
  }, [])

  if (loading) return <div className="empty-state"><p>Loading projects...</p></div>

  if (projects.length === 0) {
    return <div className="empty-state"><p>No projects with slashmem databases found.</p></div>
  }

  const groups = groupProjects(projects)
  // Find orphan worktrees (not matched to any root)
  const matchedWts = new Set(groups.flatMap(g => g.worktrees.map(w => w.name)))
  const orphans = projects.filter(p => p.path.includes('.worktrees/') && !matchedWts.has(p.name))

  return (
    <div className="mem-projects-tab">
      <p className="mem-ingest-desc">
        Memory is scoped per git repository. Worktrees create separate databases — their memory is isolated from the parent project.
      </p>
      <div className="mem-projects-list">
        {groups.map(g => (
          <div key={g.root.name} className="mem-project-group">
            <div className="mem-project-card mem-project-root">
              <div className="mem-project-name">{g.name}</div>
              <div className="mem-project-path" title={g.root.path}>{g.root.path}</div>
              <div className="mem-project-meta">
                <span className="mem-project-hash">{g.root.name}</span>
                {g.worktrees.length > 0 && (
                  <button
                    className="btn btn-ghost mem-wt-toggle"
                    onClick={() => setExpandedGroup(expandedGroup === g.root.name ? null : g.root.name)}
                  >
                    {g.worktrees.length} worktree{g.worktrees.length > 1 ? 's' : ''}
                    <span className={`mem-wt-arrow ${expandedGroup === g.root.name ? 'mem-wt-arrow-open' : ''}`}>&#9656;</span>
                  </button>
                )}
              </div>
            </div>

            {expandedGroup === g.root.name && g.worktrees.length > 0 && (
              <div className="mem-wt-list">
                {g.worktrees.map(w => {
                  const wtName = w.path.split('.worktrees/').pop() || w.name
                  return (
                    <div key={w.name} className="mem-project-card mem-project-worktree">
                      <div className="mem-project-name">{wtName}</div>
                      <div className="mem-project-path" title={w.path}>{w.path}</div>
                      <div className="mem-project-hash">{w.name}</div>
                      <span className="mem-badge mem-badge-wt">worktree</span>
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        ))}

        {orphans.map(p => {
          const name = p.path.split('/').pop() || p.name
          return (
            <div key={p.name} className="mem-project-card mem-project-worktree">
              <div className="mem-project-name">{name}</div>
              <div className="mem-project-path" title={p.path}>{p.path}</div>
              <div className="mem-project-hash">{p.name}</div>
              <span className="mem-badge mem-badge-wt">worktree</span>
            </div>
          )
        })}
      </div>
    </div>
  )
}

/* ── Shared Components ─────────────────────────────────────────────────────── */

function ResultSection({ title, count, variant, children }: {
  title: string; count: number; variant?: 'warning'; children: React.ReactNode
}) {
  return (
    <section className={`memory-section ${variant === 'warning' ? 'mem-section-warning' : ''}`}>
      <h3>{title} <span className="mem-count">{count}</span></h3>
      <div className="memory-bullet-list">{children}</div>
    </section>
  )
}

function ConfidenceBar({ value }: { value: number }) {
  const pct = Math.max(0, Math.min(100, value * 100))
  const color = value >= 0.8 ? 'var(--success)' : value >= 0.4 ? 'var(--warning)' : 'var(--danger)'
  return (
    <div className="mem-confidence" title={`Confidence: ${value.toFixed(2)}`}>
      <div className="mem-confidence-track">
        <div className="mem-confidence-fill" style={{ width: `${pct}%`, background: color }} />
      </div>
      <span className="mem-confidence-val">{value.toFixed(2)}</span>
    </div>
  )
}

function DetailField({ label, value }: { label: string; value: string }) {
  return (
    <div className="mem-detail-field">
      <span className="mem-detail-label">{label}</span>
      <span className="mem-detail-value">{value}</span>
    </div>
  )
}

function SmRuleCard({ rule, variant }: { rule: SmRule; variant?: 'warning' | 'snippet' }) {
  return (
    <div className={`memory-bullet-card ${variant === 'warning' ? 'memory-bullet-warning' : variant === 'snippet' ? 'mem-snippet-card' : ''}`}>
      <div className="memory-bullet-header">
        <span className="memory-bullet-id">{rule.id}</span>
        {rule.category && <span className="memory-bullet-category">{rule.category}</span>}
        {rule.confidence != null && (
          <ConfidenceBar value={rule.confidence} />
        )}
      </div>
      <div className="memory-bullet-content">{rule.text}</div>
    </div>
  )
}
