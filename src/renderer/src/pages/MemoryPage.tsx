import React, { useState, useEffect, useCallback } from 'react'

const sb = window.slashbot

interface Bullet {
  id: string
  content: string
  category?: string
  effectiveScore?: number
  maturity?: string
  scope?: string
  state?: string
  feedbackCount?: number
  helpfulCount?: number
  harmfulCount?: number
  createdAt?: string
}

interface Trauma {
  id: string
  pattern: string
  severity?: string
  scope?: string
  healed?: boolean
  triggerCount?: number
  createdAt?: string
}

interface Stats {
  total: number
  byScope?: Record<string, number>
  byState?: Record<string, number>
  byKind?: Record<string, number>
  scoreDistribution?: { excellent: number; good: number; neutral: number; atRisk: number }
  atRiskCount?: number
  staleCount?: number
}

type Tab = 'rules' | 'top' | 'stale' | 'traumas' | 'query'

export default function MemoryPage() {
  const [available, setAvailable] = useState<boolean | null>(null)
  const [activeTab, setActiveTab] = useState<Tab>('rules')
  const [stats, setStats] = useState<Stats | null>(null)
  const [bullets, setBullets] = useState<Bullet[]>([])
  const [topBullets, setTopBullets] = useState<Bullet[]>([])
  const [staleBullets, setStaleBullets] = useState<Bullet[]>([])
  const [traumas, setTraumas] = useState<Trauma[]>([])
  const [queryTask, setQueryTask] = useState('')
  const [queryResult, setQueryResult] = useState<unknown>(null)
  const [querying, setQuerying] = useState(false)
  const [detail, setDetail] = useState<{ id: string; data: unknown } | null>(null)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    sb.cm.check().then(r => setAvailable(r.available))
  }, [])

  const loadTab = useCallback(async (tab: Tab) => {
    setLoading(true)
    setDetail(null)
    try {
      if (tab === 'rules') {
        const [s, r] = await Promise.all([sb.cm.stats(), sb.cm.playbookList()])
        setStats((s as { data?: Stats })?.data ?? null)
        setBullets(((r as { data?: { bullets?: Bullet[] } })?.data?.bullets) ?? [])
      } else if (tab === 'top') {
        const r = await sb.cm.top(20)
        setTopBullets(((r as { data?: { bullets?: Bullet[] } })?.data?.bullets) ?? [])
      } else if (tab === 'stale') {
        const r = await sb.cm.stale()
        setStaleBullets(((r as { data?: { bullets?: Bullet[] } })?.data?.bullets) ?? [])
      } else if (tab === 'traumas') {
        const r = await sb.cm.traumaList()
        setTraumas(((r as { data?: { traumas?: Trauma[] } })?.data?.traumas) ?? [])
      }
    } catch { /* ignore */ }
    setLoading(false)
  }, [])

  useEffect(() => {
    if (available) loadTab(activeTab)
  }, [available, activeTab, loadTab])

  const showDetail = useCallback(async (id: string) => {
    try {
      const r = await sb.cm.why(id)
      setDetail({ id, data: r })
    } catch { /* ignore */ }
  }, [])

  const runQuery = useCallback(async () => {
    if (!queryTask.trim()) return
    setQuerying(true)
    try {
      const r = await sb.cm.context(queryTask)
      setQueryResult(r)
    } catch (e) {
      setQueryResult({ error: e instanceof Error ? e.message : String(e) })
    }
    setQuerying(false)
  }, [queryTask])

  if (available === null) return <div className="page"><p>Checking cm CLI...</p></div>
  if (!available) return (
    <div className="page">
      <header className="page-header"><h2>Memory</h2></header>
      <div className="empty-state-sm">
        <p>CASS Memory (<code>cm</code>) is not installed.</p>
        <p style={{ fontSize: 12, color: 'var(--fg-2)', marginTop: 8 }}>
          Install from: <code>npm i -g cass-memory</code>
        </p>
      </div>
    </div>
  )

  const scoreColor = (score?: number) => {
    if (!score) return 'idle'
    if (score >= 7) return 'success'
    if (score >= 4) return 'warning'
    return 'danger'
  }

  const renderBulletList = (items: Bullet[], emptyMsg: string) => (
    <div className="activity-list">
      {items.length === 0 && !loading && (
        <div className="empty-state-sm"><p>{emptyMsg}</p></div>
      )}
      {items.map(b => (
        <div key={b.id} className="activity-item" style={{ cursor: 'pointer' }}
          onClick={() => showDetail(b.id)}>
          <span className={`badge badge-${scoreColor(b.effectiveScore)}`} style={{ minWidth: 36, textAlign: 'center' }}>
            {b.effectiveScore?.toFixed(1) ?? '-'}
          </span>
          {b.category && <span className="badge badge-info">{b.category}</span>}
          {b.maturity && <span className="activity-files">{b.maturity}</span>}
          <span className="activity-summary" style={{ flex: 1 }}>{b.content}</span>
          <span className="activity-files">{b.id}</span>
        </div>
      ))}
    </div>
  )

  return (
    <div className="page memory-page">
      <header className="page-header">
        <h2>Memory</h2>
        {stats && (
          <span style={{ fontSize: 13, color: 'var(--fg-2)', marginLeft: 12 }}>
            {stats.total} rules
            {stats.atRiskCount ? ` \u00B7 ${stats.atRiskCount} at risk` : ''}
            {stats.staleCount ? ` \u00B7 ${stats.staleCount} stale` : ''}
          </span>
        )}
      </header>

      {/* Stats overview */}
      {stats && stats.total > 0 && stats.scoreDistribution && (
        <div className="stats-bar">
          <div className="stats-numbers">
            <span className="stat-chip done">{stats.scoreDistribution.excellent} excellent</span>
            <span className="stat-chip claimed">{stats.scoreDistribution.good} good</span>
            <span className="stat-chip ready">{stats.scoreDistribution.neutral} neutral</span>
            <span className="stat-chip failed">{stats.scoreDistribution.atRisk} at risk</span>
          </div>
        </div>
      )}

      {/* Tabs */}
      <div className="swarm-tabs">
        {(['rules', 'top', 'stale', 'traumas', 'query'] as Tab[]).map(t => (
          <button key={t} className={`tab ${activeTab === t ? 'active' : ''}`}
            onClick={() => setActiveTab(t)}>
            {t === 'rules' ? `Rules (${bullets.length})` :
             t === 'top' ? 'Top' :
             t === 'stale' ? 'Stale' :
             t === 'traumas' ? `Traumas (${traumas.length})` :
             'Query'}
          </button>
        ))}
      </div>

      <div className="swarm-content">
        {/* Detail overlay */}
        {detail && (
          <div style={{ marginBottom: 16 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
              <button className="btn btn-xs btn-ghost" onClick={() => setDetail(null)}>
                {'\u2190'} Back
              </button>
              <span style={{ fontSize: 13, fontWeight: 600 }}>{detail.id}</span>
            </div>
            <pre className="memory-detail">
              {JSON.stringify(detail.data, null, 2)}
            </pre>
          </div>
        )}

        {!detail && activeTab === 'rules' && renderBulletList(bullets, 'No rules yet. Run cm reflect or add rules manually.')}
        {!detail && activeTab === 'top' && renderBulletList(topBullets, 'No top performers yet.')}
        {!detail && activeTab === 'stale' && renderBulletList(staleBullets, 'No stale rules.')}

        {!detail && activeTab === 'traumas' && (
          <div className="activity-list">
            {traumas.length === 0 && !loading && (
              <div className="empty-state-sm"><p>No traumas recorded.</p></div>
            )}
            {traumas.map(t => (
              <div key={t.id} className="activity-item">
                <span className={`badge badge-${t.severity === 'FATAL' ? 'danger' : t.severity === 'HIGH' ? 'warning' : 'info'}`}>
                  {t.severity ?? 'MEDIUM'}
                </span>
                <code className="activity-summary" style={{ flex: 1, fontSize: 12 }}>{t.pattern}</code>
                {t.triggerCount !== undefined && t.triggerCount > 0 && (
                  <span className="activity-files">triggered {t.triggerCount}x</span>
                )}
                <span className="activity-files">{t.id}</span>
              </div>
            ))}
          </div>
        )}

        {!detail && activeTab === 'query' && (
          <div>
            <div className="plan-inject" style={{ marginBottom: 16 }}>
              <input
                className="textarea textarea-prompt"
                style={{ minHeight: 'auto', padding: '8px 12px' }}
                placeholder="Describe a task to query CASS memory..."
                value={queryTask}
                onChange={e => setQueryTask(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') runQuery() }}
              />
              <button className="btn btn-primary" onClick={runQuery} disabled={!queryTask.trim() || querying}>
                {querying ? 'Querying...' : 'Query'}
              </button>
            </div>
            {queryResult && (
              <pre className="memory-detail">
                {JSON.stringify(queryResult, null, 2)}
              </pre>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
