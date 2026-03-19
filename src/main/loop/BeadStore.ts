/**
 * BeadStore.ts — fast SQLite-backed bead store for swarm routing.
 *
 * Replaces the bd-CLI subprocess approach with direct SQLite access:
 *   • Bead creation: single bulk INSERT (PlanLoop)
 *   • Routing: indexed SELECT on (status, priority)
 *   • Atomic claim: UPDATE … WHERE status='ready' → changes === 1
 *   • Completion: UPDATE status='done' + unlock newly-ready beads
 *   • Stats: single aggregate SELECT
 */

import Database, { type Database as DB } from 'better-sqlite3'
import { mkdirSync } from 'fs'
import { join } from 'path'
import type { Bead, BeadStatus, BeadType } from './Bead'

// ── Types ───────────────────────────────────────────────────────────────────

export interface BeadRow {
  id:           string
  title:        string
  description:  string
  type:         string
  status:       string
  deps:         string   // JSON
  files:        string   // JSON
  priority:     number
  tags:         string   // JSON
  claimed_by:   string | null
  claimed_at:   string | null
  completed_at: string | null
  failed_at:    string | null
  epic_id:      string | null
  task_id:      string | null
  created_at:   string
}

export interface BeadStats {
  total:   number
  pending: number
  ready:   number
  claimed: number
  done:    number
  failed:  number
  pct:     number
}

// ── BeadStore ───────────────────────────────────────────────────────────────

export class BeadStore {
  private readonly db: DB

  constructor(ralphDir: string) {
    mkdirSync(ralphDir, { recursive: true })
    this.db = new Database(join(ralphDir, 'beads.db'))
    this.db.pragma('journal_mode = WAL')  // fast concurrent reads
    this.db.pragma('synchronous = NORMAL')
    this._migrate()
  }

  close(): void { this.db.close() }

  // ── Schema ────────────────────────────────────────────────────────────────

  private _migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS beads (
        id           TEXT PRIMARY KEY,
        title        TEXT NOT NULL,
        description  TEXT DEFAULT '',
        type         TEXT DEFAULT 'task',
        status       TEXT DEFAULT 'pending',
        deps         TEXT DEFAULT '[]',
        files        TEXT DEFAULT '[]',
        priority     INTEGER DEFAULT 5,
        tags         TEXT DEFAULT '[]',
        claimed_by   TEXT,
        claimed_at   TEXT,
        completed_at TEXT,
        failed_at    TEXT,
        epic_id      TEXT,
        task_id      TEXT,
        created_at   TEXT DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_status    ON beads(status);
      CREATE INDEX IF NOT EXISTS idx_status_p  ON beads(status, priority DESC);
    `)
  }

  // ── Write ─────────────────────────────────────────────────────────────────

  /** Wipe all beads — called before a new plan is loaded. */
  clear(): void {
    this.db.prepare('DELETE FROM beads').run()
  }

  /** Bulk insert beads from a plan encode. Uses a transaction for speed. */
  insertMany(beads: Bead[]): void {
    const insert = this.db.prepare(`
      INSERT OR REPLACE INTO beads
        (id, title, description, type, status, deps, files,
         priority, tags, epic_id, task_id)
      VALUES
        (@id, @title, @description, @type, @status, @deps, @files,
         @priority, @tags, @epicId, @taskId)
    `)
    const run = this.db.transaction((rows: Bead[]) => {
      for (const b of rows) {
        insert.run({
          id:          b.id,
          title:       b.title,
          description: b.description,
          type:        b.type,
          status:      b.status,
          deps:        JSON.stringify(b.deps),
          files:       JSON.stringify(b.files),
          priority:    b.priority,
          tags:        JSON.stringify(b.tags),
          epicId:      b.epicId ?? null,
          taskId:      b.taskId ?? null,
        })
      }
    })
    run(beads)
  }

  // ── Claim ─────────────────────────────────────────────────────────────────

  /**
   * Atomically claim the highest-priority ready bead whose files don't
   * conflict with `lockedFiles`. Returns the claimed bead or null.
   *
   * Uses UPDATE … WHERE status='ready' which SQLite serialises — the
   * first writer wins; second gets changes=0 and moves on.
   */
  claimBestBead(agentId: string, lockedFiles: string[]): Bead | null {
    const lockedSet = new Set(lockedFiles)

    const ready = this.db.prepare(
      `SELECT * FROM beads WHERE status = 'ready' ORDER BY priority DESC LIMIT 50`
    ).all() as BeadRow[]

    for (const row of ready) {
      const files = JSON.parse(row.files) as string[]
      // Skip if any file is locked by another agent
      if (files.some(f => lockedSet.has(f))) continue

      const now    = new Date().toISOString()
      const result = this.db.prepare(
        `UPDATE beads SET status='claimed', claimed_by=?, claimed_at=?
         WHERE id=? AND status='ready'`
      ).run(agentId, now, row.id)

      if (result.changes === 1) return rowToBead({ ...row, status: 'claimed', claimed_by: agentId, claimed_at: now })
    }
    return null
  }

  // ── Complete / Fail ───────────────────────────────────────────────────────

  /**
   * Mark a bead done and promote any newly-unblocked beads to 'ready'.
   * Returns the list of bead ids that were unlocked.
   */
  completeBead(beadId: string): string[] {
    this.db.prepare(
      `UPDATE beads SET status='done', completed_at=? WHERE id=?`
    ).run(new Date().toISOString(), beadId)
    return this._promoteReady()
  }

  failBead(beadId: string): void {
    this.db.prepare(
      `UPDATE beads SET status='failed', failed_at=? WHERE id=?`
    ).run(new Date().toISOString(), beadId)
  }

  // ── Queries ───────────────────────────────────────────────────────────────

  getById(id: string): Bead | null {
    const row = this.db.prepare('SELECT * FROM beads WHERE id=?').get(id) as BeadRow | undefined
    return row ? rowToBead(row) : null
  }

  listByStatus(status: string): Bead[] {
    return (this.db.prepare('SELECT * FROM beads WHERE status=? ORDER BY priority DESC').all(status) as BeadRow[])
      .map(rowToBead)
  }

  listAll(): Bead[] {
    return (this.db.prepare('SELECT * FROM beads ORDER BY priority DESC').all() as BeadRow[]).map(rowToBead)
  }

  stats(): BeadStats {
    const row = this.db.prepare(`
      SELECT
        COUNT(*)                                   AS total,
        SUM(CASE WHEN status='pending' THEN 1 ELSE 0 END) AS pending,
        SUM(CASE WHEN status='ready'   THEN 1 ELSE 0 END) AS ready,
        SUM(CASE WHEN status='claimed' THEN 1 ELSE 0 END) AS claimed,
        SUM(CASE WHEN status='done'    THEN 1 ELSE 0 END) AS done,
        SUM(CASE WHEN status='failed'  THEN 1 ELSE 0 END) AS failed
      FROM beads
    `).get() as Record<string, number>

    const total = row['total']  ?? 0
    const done  = row['done']   ?? 0
    return {
      total,
      pending: row['pending'] ?? 0,
      ready:   row['ready']   ?? 0,
      claimed: row['claimed'] ?? 0,
      done,
      failed:  row['failed']  ?? 0,
      pct:     total > 0 ? Math.round((done / total) * 100) : 0,
    }
  }

  /** True if any beads still need work. */
  hasOpenWork(): boolean {
    const row = this.db.prepare(
      `SELECT COUNT(*) AS n FROM beads WHERE status IN ('ready','claimed','pending')`
    ).get() as { n: number }
    return row.n > 0
  }

  // ── Internal ──────────────────────────────────────────────────────────────

  /**
   * After any completion, check if pending beads are now fully unblocked.
   * A bead is ready when all its deps are 'done'.
   */
  private _promoteReady(): string[] {
    const doneIds = new Set(
      (this.db.prepare(`SELECT id FROM beads WHERE status='done'`).all() as { id: string }[]).map(r => r.id)
    )

    const pending = this.db.prepare(
      `SELECT id, deps FROM beads WHERE status='pending'`
    ).all() as { id: string; deps: string }[]

    const toPromote: string[] = []
    for (const { id, deps } of pending) {
      const depList = JSON.parse(deps) as string[]
      if (depList.every(d => doneIds.has(d))) toPromote.push(id)
    }

    if (toPromote.length > 0) {
      const placeholders = toPromote.map(() => '?').join(',')
      this.db.prepare(`UPDATE beads SET status='ready' WHERE id IN (${placeholders})`).run(...toPromote)
    }
    return toPromote
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function rowToBead(row: BeadRow): Bead {
  return {
    id:           row.id,
    title:        row.title,
    description:  row.description,
    type:         row.type as BeadType,
    status:       row.status as BeadStatus,
    deps:         safeJson(row.deps,  []),
    files:        safeJson(row.files, []),
    priority:     row.priority,
    tags:         safeJson(row.tags,  []),
    claimedBy:    row.claimed_by   ?? undefined,
    claimedAt:    row.claimed_at   ?? undefined,
    completedAt:  row.completed_at ?? undefined,
    failedAt:     row.failed_at    ?? undefined,
    epicId:       row.epic_id      ?? undefined,
    taskId:       row.task_id      ?? undefined,
  }
}

function safeJson<T>(raw: string, fallback: T): T {
  try { return JSON.parse(raw) as T } catch { return fallback }
}
