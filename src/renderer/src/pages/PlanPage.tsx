import React, { useState, useEffect, useCallback } from 'react'
import AgentOutputRenderer from '../components/AgentOutputRenderer'
import { globalAgentOutputs } from '../App'
import type { PlanQueueItem } from '../types/ipc'

const sb = window.slashbot

interface PlanLogEntry {
  file: string
  agentId: string
  phase: string
  timestamp: string
  size: number
}

interface Props {
  projectPath: string
  agentOutputs: Record<string, string>
  setAgentOutputs: React.Dispatch<React.SetStateAction<Record<string, string>>>
}

export default function PlanPage({ projectPath, agentOutputs, setAgentOutputs }: Props) {
  const [planPrompt, setPlanPrompt] = useState('')
  const [isPlanning, setIsPlanning] = useState(false)
  const [planPhase, setPlanPhase] = useState('')
  const [planRequest, setPlanRequest] = useState('')
  const [planQueue, setPlanQueue] = useState<PlanQueueItem[]>([])
  const [activeTab, setActiveTab] = useState<'current' | 'history'>('current')
  const [historyLogs, setHistoryLogs] = useState<PlanLogEntry[]>([])
  const [historyContent, setHistoryContent] = useState<string | null>(null)
  const [historyFile, setHistoryFile] = useState<string | null>(null)

  // Load initial state + listeners
  useEffect(() => {
    sb.swarm.status(projectPath).then(s => {
      setIsPlanning(s.planning ?? false)
      setPlanRequest(s.planRequest ?? '')
    })
    sb.swarm.queue(projectPath).then(setPlanQueue)
    const unsubs = [
      sb.swarm.onPlanPhase((_p: string, phase: string, request?: string) => {
        setPlanPhase(phase)
        setPlanRequest(request ?? '')
        setIsPlanning(phase !== '' && phase !== 'done')
        if (phase === 'done') setPlanRequest('')
      }),
      sb.swarm.onPlanQueue((_p: string, q: PlanQueueItem[]) => setPlanQueue(q)),
      sb.swarm.onStopped(() => { setIsPlanning(false); setPlanRequest('') }),
    ]
    return () => unsubs.forEach(u => u())
  }, [projectPath])

  // Fetch planner output history on mount
  useEffect(() => {
    if (!agentOutputs['planner']) {
      sb.swarm.agentOutput(projectPath, 'planner').then(output => {
        if (output) {
          globalAgentOutputs['planner'] = output
          setAgentOutputs(prev => ({ ...prev, planner: output }))
        }
      })
    }
  }, [projectPath])

  // Load plan history logs
  const loadHistory = useCallback(() => {
    sb.swarm.agentLogs(projectPath).then(logs => {
      const planLogs = logs.filter(l => l.file.startsWith('planner_'))
      planLogs.sort((a, b) => b.timestamp.localeCompare(a.timestamp))
      setHistoryLogs(planLogs)
    })
  }, [projectPath])

  useEffect(() => { loadHistory() }, [loadHistory])

  const injectPlan = useCallback(async () => {
    if (!planPrompt.trim()) return
    await sb.swarm.inject(projectPath, planPrompt)
    setPlanPrompt('')
  }, [projectPath, planPrompt])

  const hasOutput = !!agentOutputs['planner']

  return (
    <div className="page plan-page">
      <header className="page-header">
        <h2>Plan</h2>
        {isPlanning && (
          <span className="badge badge-warning animate-pulse" style={{ marginLeft: 12 }}>
            {planPhase || 'planning'}
          </span>
        )}
      </header>

      {/* Inject prompt */}
      <div className="plan-inject">
        <textarea
          className="textarea textarea-prompt"
          placeholder="Describe what you want to build... Claude will analyze the codebase, create a plan, and encode it as beads."
          rows={3}
          value={planPrompt}
          onChange={e => setPlanPrompt(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && e.metaKey) injectPlan() }}
        />
        <button className="btn btn-primary" onClick={injectPlan} disabled={!planPrompt.trim()}>
          {isPlanning ? `+ Queue (${planQueue.length + 1})` : 'Inject Plan'}
        </button>
      </div>

      {/* Queue */}
      {(isPlanning || planQueue.length > 0) && (
        <div className="plan-queue">
          {isPlanning && (
            <div className="plan-queue-item plan-queue-active">
              <span className="badge badge-warning animate-pulse">{planPhase || 'planning'}</span>
              <span className="plan-queue-text" title={planRequest}>
                {planRequest ? (planRequest.length > 100 ? planRequest.slice(0, 100) + '...' : planRequest) : 'Running...'}
              </span>
            </div>
          )}
          {planQueue.map((q, i) => (
            <div key={q.id} className="plan-queue-item">
              <span className="badge badge-idle">#{i + 1}</span>
              <span className="plan-queue-text">{q.request.slice(0, 100)}{q.request.length > 100 ? '...' : ''}</span>
              <button className="btn btn-sm btn-ghost" onClick={() => sb.swarm.queueRemove(projectPath, q.id)}>
                {'\u2715'}
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Tabs: Current / History */}
      <div className="swarm-tabs-nav">
        <button className={`swarm-tab ${activeTab === 'current' ? 'active' : ''}`}
          onClick={() => setActiveTab('current')}>
          Live output
        </button>
        <button className={`swarm-tab ${activeTab === 'history' ? 'active' : ''}`}
          onClick={() => { setActiveTab('history'); loadHistory() }}>
          History ({historyLogs.length})
        </button>
      </div>

      <div className="swarm-content">
        {activeTab === 'current' && (
          hasOutput ? (
            <div className="plan-output">
              <div className="agent-output agent-output-live">
                <AgentOutputRenderer output={agentOutputs['planner']} />
              </div>
            </div>
          ) : (
            <div className="empty-state-sm">
              <p>No planner output yet. Inject a plan to get started.</p>
            </div>
          )
        )}

        {activeTab === 'history' && (
          historyContent && historyFile ? (
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                <button className="btn btn-xs btn-ghost" onClick={() => { setHistoryContent(null); setHistoryFile(null) }}>
                  {'\u2190'} Back
                </button>
                <span style={{ fontSize: 12, color: 'var(--fg-2)' }}>{historyFile}</span>
              </div>
              <div className="agent-output agent-output-live">
                <AgentOutputRenderer output={historyContent} />
              </div>
            </div>
          ) : (
            <div className="activity-list">
              {historyLogs.length === 0 && (
                <div className="empty-state-sm"><p>No plan history yet.</p></div>
              )}
              {historyLogs.map(log => {
                const label = log.file.replace('planner_', '').replace(/\.log$/, '')
                return (
                  <div key={log.file} className="activity-item" style={{ cursor: 'pointer' }}
                    onClick={() => {
                      setHistoryFile(log.file)
                      sb.swarm.agentLogContent(projectPath, log.file).then(setHistoryContent)
                    }}>
                    <span className={`agent-dot ${log.phase === 'plan' ? 'thinking' : 'executing'}`} />
                    <span className={`badge badge-${log.phase.includes('batch') || log.phase.includes('encode') ? 'success' : 'accent'}`}>
                      {log.phase.includes('batch') || log.phase.includes('encode') ? 'encode' : 'plan'}
                    </span>
                    <span className="activity-summary">{label}</span>
                    <span className="activity-files">{(log.size / 1024).toFixed(0)}KB</span>
                  </div>
                )
              })}
            </div>
          )
        )}
      </div>
    </div>
  )
}
