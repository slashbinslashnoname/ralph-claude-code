#!/usr/bin/env node
/**
 * MCP Coordination Server for Slashbot agents.
 *
 * Spawned per-agent as a stdio MCP server. Exposes tools for inter-agent
 * communication and status awareness. Reads/writes shared files in .slashbot/
 * (symlinked into each worktree).
 *
 * Environment variables:
 *   SLASHBOT_AGENT_ID  — this agent's identifier (e.g. "agent-0")
 *   SLASHBOT_STORE_DIR — absolute path to .slashbot/ directory
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import * as fs from 'fs'
import * as path from 'path'

const agentId = process.env.SLASHBOT_AGENT_ID ?? 'unknown'
const storeDir = process.env.SLASHBOT_STORE_DIR ?? '.slashbot'

// ── File helpers ─────────────────────────────────────────────────────────────

interface AgentInfo {
  id: string
  phase: string
  currentBeadId: string | null
  currentBeadTitle: string | null
  worktreeBranch: string | null
  thinkingSummary: string | null
  lastActivity: string
}

interface FileLock {
  file: string
  agentId: string
  beadId: string
  reservedAt: string
}

interface MailMessage {
  ts: string
  from: string
  to: string
  subject: string
  body: string
  threadId: string
  read: boolean
}

interface ActivityEvent {
  ts: string
  agentId: string
  type: string
  beadId?: string
  beadTitle?: string
  summary?: string
  filesChanged?: string[]
}

function readJsonFile<T>(filename: string, fallback: T): T {
  const filepath = path.join(storeDir, filename)
  try {
    return JSON.parse(fs.readFileSync(filepath, 'utf8'))
  } catch {
    return fallback
  }
}

function readJsonlFile<T>(filename: string): T[] {
  const filepath = path.join(storeDir, filename)
  try {
    return fs.readFileSync(filepath, 'utf8')
      .split('\n')
      .filter(l => l.trim())
      .map(l => JSON.parse(l))
  } catch {
    return []
  }
}

function appendJsonl(filename: string, record: unknown): void {
  const filepath = path.join(storeDir, filename)
  fs.appendFileSync(filepath, JSON.stringify(record) + '\n')
}

// ── MCP Server ───────────────────────────────────────────────────────────────

const server = new McpServer({
  name: 'slashbot-coordination',
  version: '1.0.0',
})

// ── Tool: team_status ────────────────────────────────────────────────────────

server.tool(
  'team_status',
  'See what all agents are currently working on — their phase, current bead, and recent activity. Call this at the start of your work to understand the team context.',
  {},
  async () => {
    const agents: AgentInfo[] = readJsonFile('agents.json', [])
    const activity: ActivityEvent[] = readJsonlFile('activity.jsonl')

    const lines: string[] = ['# Team Status\n']

    for (const a of agents) {
      const isMe = a.id === agentId
      const marker = isMe ? ' (you)' : ''
      const bead = a.currentBeadId
        ? `[${a.currentBeadId}] ${a.currentBeadTitle ?? ''}`
        : 'idle'
      lines.push(`## ${a.id}${marker}`)
      lines.push(`- **Phase**: ${a.phase}`)
      lines.push(`- **Working on**: ${bead}`)
      if (a.worktreeBranch) lines.push(`- **Branch**: ${a.worktreeBranch}`)
      if (a.thinkingSummary && !isMe) {
        const summary = a.thinkingSummary.length > 300
          ? a.thinkingSummary.slice(0, 300) + '…'
          : a.thinkingSummary
        lines.push(`- **Thinking summary**: ${summary}`)
      }
      lines.push('')
    }

    // Recent activity (last 15 events, excluding heartbeats)
    const recent = activity
      .filter(e => e.type !== 'heartbeat' && e.type !== 'started')
      .slice(-15)
    if (recent.length > 0) {
      lines.push('## Recent Activity')
      for (const e of recent) {
        const age = Math.round((Date.now() - new Date(e.ts).getTime()) / 60_000)
        const beadInfo = e.beadId ? ` [${e.beadId}] ${e.beadTitle ?? ''}` : ''
        const summary = e.summary ? ` — ${e.summary}` : ''
        lines.push(`- ${age}m ago: **${e.agentId}** ${e.type}${beadInfo}${summary}`)
      }
    }

    return { content: [{ type: 'text' as const, text: lines.join('\n') }] }
  }
)

// ── Tool: send_message ───────────────────────────────────────────────────────

server.tool(
  'send_message',
  'Send a message to another agent or broadcast to all agents. Use this to coordinate on shared files, report discoveries, or request help.',
  {
    to: z.string().describe('Recipient agent ID (e.g. "agent-1") or "all" to broadcast'),
    subject: z.string().describe('Short subject line'),
    body: z.string().describe('Message body — be concise and actionable'),
    thread_id: z.string().optional().describe('Thread ID for grouping messages (defaults to your current bead ID)'),
  },
  async ({ to, subject, body, thread_id }) => {
    const msg: MailMessage = {
      ts: new Date().toISOString(),
      from: agentId,
      to,
      subject,
      body,
      threadId: thread_id ?? 'general',
      read: false,
    }
    appendJsonl('mail.jsonl', msg)
    return { content: [{ type: 'text' as const, text: `Message sent to ${to}: "${subject}"` }] }
  }
)

// ── Tool: check_inbox ────────────────────────────────────────────────────────

server.tool(
  'check_inbox',
  'Check for messages from other agents. Returns unread messages by default.',
  {
    unread_only: z.boolean().default(true).describe('If true, only return unread messages'),
  },
  async ({ unread_only }) => {
    const filepath = path.join(storeDir, 'mail.jsonl')
    let allMessages: MailMessage[] = []
    try {
      allMessages = fs.readFileSync(filepath, 'utf8')
        .split('\n')
        .filter(l => l.trim())
        .map(l => JSON.parse(l))
    } catch {
      return { content: [{ type: 'text' as const, text: 'No messages.' }] }
    }

    // Filter messages for this agent
    const myMessages = allMessages.filter(
      m => m.to === agentId || m.to === 'all'
    )
    const filtered = unread_only ? myMessages.filter(m => !m.read) : myMessages

    if (filtered.length === 0) {
      return { content: [{ type: 'text' as const, text: 'No messages.' }] }
    }

    // Mark as read by rewriting the file
    if (unread_only && filtered.length > 0) {
      const readTs = new Set(filtered.map(m => m.ts + m.from))
      const updated = allMessages.map(m => {
        if ((m.to === agentId || m.to === 'all') && readTs.has(m.ts + m.from)) {
          return { ...m, read: true }
        }
        return m
      })
      try {
        fs.writeFileSync(filepath, updated.map(m => JSON.stringify(m)).join('\n') + '\n')
      } catch { /* best-effort */ }
    }

    const lines = filtered.map(m => {
      const age = Math.round((Date.now() - new Date(m.ts).getTime()) / 60_000)
      return `**From ${m.from}** (${age}m ago) — ${m.subject}\n${m.body}`
    })

    return { content: [{ type: 'text' as const, text: lines.join('\n\n---\n\n') }] }
  }
)

// ── Tool: check_file_reservations ────────────────────────────────────────────

server.tool(
  'check_file_reservations',
  'Check which files are currently being modified by other agents. Use before editing shared files to avoid conflicts.',
  {},
  async () => {
    const locks: FileLock[] = readJsonFile('.guards', [])
    const otherLocks = locks.filter(l => l.agentId !== agentId)

    if (otherLocks.length === 0) {
      return { content: [{ type: 'text' as const, text: 'No files are currently reserved by other agents.' }] }
    }

    const byAgent = new Map<string, FileLock[]>()
    for (const l of otherLocks) {
      const existing = byAgent.get(l.agentId) ?? []
      existing.push(l)
      byAgent.set(l.agentId, existing)
    }

    const lines: string[] = ['# File Reservations\n']
    for (const [aid, fileLocks] of byAgent) {
      lines.push(`## ${aid}`)
      for (const l of fileLocks) {
        lines.push(`- \`${l.file}\` (bead: ${l.beadId})`)
      }
      lines.push('')
    }

    lines.push('> Avoid modifying these files unless coordinating with the other agent.')

    return { content: [{ type: 'text' as const, text: lines.join('\n') }] }
  }
)

// ── Start ────────────────────────────────────────────────────────────────────

async function main() {
  const transport = new StdioServerTransport()
  await server.connect(transport)
}

main().catch(err => {
  process.stderr.write(`MCP coordination server error: ${err}\n`)
  process.exit(1)
})
