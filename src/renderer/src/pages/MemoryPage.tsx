import React, { useState, useEffect, useCallback } from 'react'
import type { MemoryBullet, SmRule } from '../types/ipc'

const sb = window.slashbot

interface Props { projectPath: string }

type SearchMode = 'context' | 'similar' | 'slashmem'

export default function MemoryPage({ projectPath }: Props) {
  const [installed, setInstalled] = useState<boolean | null>(null)
  const [smInstalled, setSmInstalled] = useState<boolean | null>(null)
  const [query, setQuery] = useState('')
  const [mode, setMode] = useState<SearchMode>('context')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Context results
  const [relevantBullets, setRelevantBullets] = useState<MemoryBullet[]>([])
  const [antiPatterns, setAntiPatterns] = useState<MemoryBullet[]>([])
  const [suggestedQueries, setSuggestedQueries] = useState<string[]>([])

  // Similar results
  const [similarResults, setSimilarResults] = useState<MemoryBullet[]>([])

  // Slashmem results
  const [smRules, setSmRules] = useState<SmRule[]>([])
  const [smAntiPatterns, setSmAntiPatterns] = useState<SmRule[]>([])
  const [smSnippets, setSmSnippets] = useState<SmRule[]>([])

  const [executionMs, setExecutionMs] = useState<number | null>(null)
  const [hasSearched, setHasSearched] = useState(false)

  useEffect(() => {
    sb.memory.check().then(r => setInstalled(r.installed))
    sb.memory.smCheck().then(r => setSmInstalled(r.installed))
  }, [])

  const clearResults = useCallback(() => {
    setRelevantBullets([])
    setAntiPatterns([])
    setSuggestedQueries([])
    setSimilarResults([])
    setSmRules([])
    setSmAntiPatterns([])
    setSmSnippets([])
    setError(null)
    setExecutionMs(null)
  }, [])

  const search = useCallback(async () => {
    if (!query.trim()) return
    setLoading(true)
    clearResults()
    setHasSearched(true)

    try {
      if (mode === 'context') {
        const r = await sb.memory.context(projectPath, query.trim())
        if (!r.ok) { setError(r.error ?? 'Unknown error'); return }
        const data = r.data!
        setRelevantBullets(data.data?.relevantBullets ?? [])
        setAntiPatterns(data.data?.antiPatterns ?? [])
        setSuggestedQueries(data.data?.suggestedCassQueries ?? [])
        setExecutionMs(data.metadata?.executionMs ?? null)
      } else if (mode === 'similar') {
        const r = await sb.memory.similar(projectPath, query.trim())
        if (!r.ok) { setError(r.error ?? 'Unknown error'); return }
        const data = r.data!
        setSimilarResults(data.data?.results ?? [])
        setExecutionMs(data.metadata?.executionMs ?? null)
      } else {
        const r = await sb.memory.smContext(projectPath, query.trim())
        if (!r.ok) { setError(r.error ?? 'Unknown error'); return }
        const data = r.data!
        setSmRules(data.relevant_rules ?? [])
        setSmAntiPatterns(data.anti_patterns ?? [])
        setSmSnippets(data.history_snippets ?? [])
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [query, mode, projectPath, clearResults])

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      search()
    }
  }, [search])

  if (installed === null) return <div className="page"><p>Loading...</p></div>

  const neitherInstalled = !installed && !smInstalled

  if (neitherInstalled) {
    return (
      <div className="page">
        <header className="page-header"><h2>Memory</h2></header>
        <div className="empty-state">
          <p>No memory CLI is installed.</p>
          <p>Install <code>cm</code> or <code>sm</code> to enable memory search:</p>
          <pre>npm install -g cass-memory   # cm CLI{'\n'}cargo install slashmem       # sm CLI</pre>
        </div>
      </div>
    )
  }

  const totalResults = mode === 'context'
    ? relevantBullets.length + antiPatterns.length
    : mode === 'similar'
      ? similarResults.length
      : smRules.length + smAntiPatterns.length + smSnippets.length

  const cmAvailable = installed === true
  const smAvailable = smInstalled === true

  return (
    <div className="page">
      <header className="page-header">
        <h2>Memory</h2>
        {executionMs !== null && (
          <span className="status-text">{executionMs}ms</span>
        )}
      </header>

      <div className="memory-search">
        <div className="memory-search-bar">
          <input
            type="text"
            className="input"
            placeholder={
              mode === 'slashmem'
                ? 'Search slashmem project memories...'
                : mode === 'context'
                  ? 'Describe a task to get relevant rules...'
                  : 'Search for similar playbook entries...'
            }
            value={query}
            onChange={e => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            disabled={loading}
          />
          <button
            className="btn btn-primary"
            onClick={search}
            disabled={loading || !query.trim()}
          >
            {loading ? 'Searching...' : 'Search'}
          </button>
        </div>
        <div className="memory-mode-tabs">
          {cmAvailable && (
            <>
              <button
                className={`btn btn-ghost ${mode === 'context' ? 'active' : ''}`}
                onClick={() => { setMode('context'); clearResults(); setHasSearched(false) }}
              >
                Context
              </button>
              <button
                className={`btn btn-ghost ${mode === 'similar' ? 'active' : ''}`}
                onClick={() => { setMode('similar'); clearResults(); setHasSearched(false) }}
              >
                Similar
              </button>
            </>
          )}
          {smAvailable && (
            <button
              className={`btn btn-ghost ${mode === 'slashmem' ? 'active' : ''}`}
              onClick={() => { setMode('slashmem'); clearResults(); setHasSearched(false) }}
            >
              Slashmem
            </button>
          )}
        </div>
      </div>

      {error && (
        <div className="memory-error">
          <strong>Error:</strong> {error}
        </div>
      )}

      {hasSearched && !loading && !error && totalResults === 0 && (
        <div className="empty-state">
          <p>No results found for &quot;{query}&quot;</p>
        </div>
      )}

      {mode === 'context' && (
        <div className="memory-results">
          {relevantBullets.length > 0 && (
            <section className="memory-section">
              <h3>Relevant Rules ({relevantBullets.length})</h3>
              <div className="memory-bullet-list">
                {relevantBullets.map(b => (
                  <BulletCard key={b.id} bullet={b} />
                ))}
              </div>
            </section>
          )}

          {antiPatterns.length > 0 && (
            <section className="memory-section">
              <h3>Anti-Patterns ({antiPatterns.length})</h3>
              <div className="memory-bullet-list">
                {antiPatterns.map(b => (
                  <BulletCard key={b.id} bullet={b} variant="warning" />
                ))}
              </div>
            </section>
          )}

          {suggestedQueries.length > 0 && (
            <section className="memory-section">
              <h3>Suggested Queries</h3>
              <div className="memory-suggested-queries">
                {suggestedQueries.map((q, i) => (
                  <code key={i} className="memory-suggested-query">{q}</code>
                ))}
              </div>
            </section>
          )}
        </div>
      )}

      {mode === 'similar' && similarResults.length > 0 && (
        <div className="memory-results">
          <section className="memory-section">
            <h3>Similar Bullets ({similarResults.length})</h3>
            <div className="memory-bullet-list">
              {similarResults.map(b => (
                <BulletCard key={b.id} bullet={b} />
              ))}
            </div>
          </section>
        </div>
      )}

      {mode === 'slashmem' && (
        <div className="memory-results">
          {smRules.length > 0 && (
            <section className="memory-section">
              <h3>Relevant Rules ({smRules.length})</h3>
              <div className="memory-bullet-list">
                {smRules.map(r => (
                  <SmRuleCard key={r.id} rule={r} />
                ))}
              </div>
            </section>
          )}

          {smAntiPatterns.length > 0 && (
            <section className="memory-section">
              <h3>Anti-Patterns ({smAntiPatterns.length})</h3>
              <div className="memory-bullet-list">
                {smAntiPatterns.map(r => (
                  <SmRuleCard key={r.id} rule={r} variant="warning" />
                ))}
              </div>
            </section>
          )}

          {smSnippets.length > 0 && (
            <section className="memory-section">
              <h3>History Snippets ({smSnippets.length})</h3>
              <div className="memory-bullet-list">
                {smSnippets.map(r => (
                  <SmRuleCard key={r.id} rule={r} />
                ))}
              </div>
            </section>
          )}
        </div>
      )}
    </div>
  )
}

function BulletCard({ bullet, variant }: { bullet: MemoryBullet; variant?: 'warning' }) {
  return (
    <div className={`memory-bullet-card ${variant === 'warning' ? 'memory-bullet-warning' : ''}`}>
      <div className="memory-bullet-header">
        <span className="memory-bullet-id">{bullet.id}</span>
        {bullet.category && <span className="memory-bullet-category">{bullet.category}</span>}
        {bullet.score != null && <span className="memory-bullet-score">score: {bullet.score.toFixed(2)}</span>}
      </div>
      <div className="memory-bullet-content">{bullet.content}</div>
      {bullet.feedback && (
        <div className="memory-bullet-feedback">
          <span className="feedback-helpful">+{bullet.feedback.helpful}</span>
          <span className="feedback-harmful">-{bullet.feedback.harmful}</span>
        </div>
      )}
    </div>
  )
}

function SmRuleCard({ rule, variant }: { rule: SmRule; variant?: 'warning' }) {
  return (
    <div className={`memory-bullet-card ${variant === 'warning' ? 'memory-bullet-warning' : ''}`}>
      <div className="memory-bullet-header">
        <span className="memory-bullet-id">{rule.id}</span>
        {rule.category && <span className="memory-bullet-category">{rule.category}</span>}
        {rule.confidence != null && <span className="memory-bullet-score">conf: {rule.confidence.toFixed(2)}</span>}
      </div>
      <div className="memory-bullet-content">{rule.text}</div>
    </div>
  )
}
