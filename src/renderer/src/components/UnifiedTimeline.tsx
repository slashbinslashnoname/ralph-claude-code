import React, { useState, useEffect, useCallback, useMemo } from 'react'
import { AsyncButton } from './AsyncButton'
import { formatTimePrecise } from '../utils/formatTime'
import type { ActivityEvent, BdComment, Bead } from '../types/ipc'

/** A unified entry that can represent an activity event, comment, or lifecycle milestone. */
export interface TimelineEntry {
  /** ISO timestamp for sorting */
  ts: string
  /** Discriminator for rendering */
  kind: 'activity' | 'comment' | 'lifecycle'
  /** Original activity event (when kind === 'activity') */
  activity?: ActivityEvent
  /** Original comment (when kind === 'comment') */
  comment?: BdComment
  /** Lifecycle label (when kind === 'lifecycle') */
  lifecycleLabel?: string
  /** Lifecycle detail text */
  lifecycleDetail?: string
}

interface Props {
  bead: Bead
  projectPath: string
}

const EVENT_ICONS: Record<string, string> = {
  claimed: '\u2691',
  thinking: '\u2699',
  executing: '\u25B6',
  merged: '\u2714',
  completed: '\u2713',
  failed: '\u2717',
  stopped: '\u25A0',
  paused: '\u23F8',
  resumed: '\u23F5',
  started: '\u25CB',
  rollback: '\u21A9',
}

const EVENT_BADGE: Record<string, string> = {
  claimed: 'warning',
  thinking: 'accent',
  executing: 'info',
  merged: 'success',
  completed: 'success',
  failed: 'danger',
  stopped: 'idle',
  paused: 'idle',
  resumed: 'info',
  started: 'idle',
  rollback: 'danger',
}

const LIFECYCLE_ICONS: Record<string, string> = {
  created: '\u2295',
  claimed: '\u2691',
  completed: '\u2713',
  failed: '\u2717',
}

const LIFECYCLE_BADGE: Record<string, string> = {
  created: 'info',
  claimed: 'warning',
  completed: 'success',
  failed: 'danger',
}

const PAGE_SIZE = 50

export default function UnifiedTimeline({ bead, projectPath }: Props) {
  const [events, setEvents] = useState<ActivityEvent[]>([])
  const [comments, setComments] = useState<BdComment[]>([])
  const [loading, setLoading] = useState(true)
  const [newComment, setNewComment] = useState('')
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE)

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      const [activity, rawComments] = await Promise.all([
        window.slashbot.swarm.activity(projectPath, 500),
        window.slashbot.beads.comments(projectPath, bead.id),
      ])
      setEvents(activity.filter((e) => e.beadId === bead.id))
      setComments(Array.isArray(rawComments) ? rawComments : [])
    } catch {
      setEvents([])
      setComments([])
    }
    setLoading(false)
  }, [projectPath, bead.id])

  useEffect(() => { refresh() }, [refresh])

  // Reset pagination on bead change
  useEffect(() => { setVisibleCount(PAGE_SIZE) }, [bead.id])

  // Build lifecycle entries from bead metadata
  const lifecycleEntries = useMemo((): TimelineEntry[] => {
    const entries: TimelineEntry[] = []
    if (bead.createdAt) {
      entries.push({
        ts: bead.createdAt,
        kind: 'lifecycle',
        lifecycleLabel: 'created',
        lifecycleDetail: `Bead created: ${bead.title}`,
      })
    }
    if (bead.claimedAt) {
      entries.push({
        ts: bead.claimedAt,
        kind: 'lifecycle',
        lifecycleLabel: 'claimed',
        lifecycleDetail: `Claimed by ${bead.claimedBy || 'unknown'}`,
      })
    }
    if (bead.completedAt) {
      entries.push({
        ts: bead.completedAt,
        kind: 'lifecycle',
        lifecycleLabel: 'completed',
        lifecycleDetail: 'Bead completed',
      })
    }
    if (bead.failedAt) {
      entries.push({
        ts: bead.failedAt,
        kind: 'lifecycle',
        lifecycleLabel: 'failed',
        lifecycleDetail: 'Bead failed',
      })
    }
    return entries
  }, [bead])

  // Merge all entries into a single sorted timeline
  const timeline = useMemo((): TimelineEntry[] => {
    const activityEntries: TimelineEntry[] = events.map((e) => ({
      ts: e.ts,
      kind: 'activity' as const,
      activity: e,
    }))
    const commentEntries: TimelineEntry[] = comments.map((c) => ({
      ts: c.createdAt,
      kind: 'comment' as const,
      comment: c,
    }))

    // Deduplicate lifecycle entries that overlap with activity events
    // (e.g., a 'claimed' activity event and bead.claimedAt represent the same thing)
    const activityTypes = new Set(events.map((e) => e.type))
    const dedupedLifecycle = lifecycleEntries.filter((le) => {
      if (le.lifecycleLabel === 'created') return true // always show creation
      return !activityTypes.has(le.lifecycleLabel!)
    })

    const all = [...dedupedLifecycle, ...activityEntries, ...commentEntries]
    all.sort((a, b) => new Date(a.ts).getTime() - new Date(b.ts).getTime())
    return all
  }, [events, comments, lifecycleEntries])

  const visibleEntries = useMemo(
    () => timeline.slice(0, visibleCount),
    [timeline, visibleCount],
  )
  const hasMore = visibleCount < timeline.length

  const showMore = useCallback(() => {
    setVisibleCount((prev) => Math.min(prev + PAGE_SIZE, timeline.length))
  }, [timeline.length])

  const addComment = useCallback(async () => {
    if (!newComment.trim()) return
    await window.slashbot.beads.addComment(projectPath, bead.id, newComment.trim())
    setNewComment('')
    await refresh()
  }, [projectPath, bead.id, newComment, refresh])

  if (loading) {
    return (
      <div className="unified-timeline">
        <p className="unified-timeline-loading">Loading timeline...</p>
      </div>
    )
  }

  return (
    <div className="unified-timeline">
      <div className="unified-timeline-header">
        <span className="unified-timeline-title">
          Timeline ({timeline.length})
        </span>
      </div>

      {timeline.length === 0 ? (
        <p className="unified-timeline-empty">No activity yet</p>
      ) : (
        <div className="unified-timeline-entries">
          {visibleEntries.map((entry, i) => (
            <TimelineItem key={`${entry.kind}-${entry.ts}-${i}`} entry={entry} />
          ))}
          {hasMore && (
            <button
              className="btn btn-sm btn-ghost unified-timeline-show-more"
              onClick={showMore}
            >
              Show more ({timeline.length - visibleCount} remaining)
            </button>
          )}
        </div>
      )}

      {/* Comment input */}
      <div className="unified-timeline-comment-input">
        <textarea
          className="textarea comment-textarea"
          placeholder="Add a comment..."
          rows={2}
          value={newComment}
          onChange={(e) => setNewComment(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && e.metaKey) addComment() }}
        />
        <AsyncButton
          className="btn-xs btn-primary"
          onClick={addComment}
          disabled={!newComment.trim()}
          pendingContent="Posting..."
        >
          Comment
        </AsyncButton>
      </div>
    </div>
  )
}

function TimelineItem({ entry }: { entry: TimelineEntry }) {
  if (entry.kind === 'comment') {
    return <CommentItem comment={entry.comment!} />
  }
  if (entry.kind === 'lifecycle') {
    return <LifecycleItem entry={entry} />
  }
  return <ActivityItem event={entry.activity!} />
}

function ActivityItem({ event }: { event: ActivityEvent }) {
  return (
    <div className="unified-timeline-event">
      <span className="unified-timeline-icon">
        {EVENT_ICONS[event.type] || '\u25CB'}
      </span>
      <div className="unified-timeline-line" />
      <div className="unified-timeline-content">
        <div className="unified-timeline-entry-header">
          <span className={`badge badge-${EVENT_BADGE[event.type] || 'idle'}`}>
            {event.type}
          </span>
          <span className="unified-timeline-agent">{event.agentId}</span>
          <span className="unified-timeline-time">{formatTimePrecise(event.ts)}</span>
        </div>
        {event.summary && (
          <p className="unified-timeline-summary">{event.summary}</p>
        )}
        {event.filesChanged && event.filesChanged.length > 0 && (
          <div className="unified-timeline-files">
            {event.filesChanged.map((f) => (
              <span key={f} className="tag">{f}</span>
            ))}
          </div>
        )}
        {event.branch && (
          <span className="tag tag-branch">{event.branch}</span>
        )}
      </div>
    </div>
  )
}

function CommentItem({ comment }: { comment: BdComment }) {
  return (
    <div className="unified-timeline-event unified-timeline-comment">
      <span className="unified-timeline-icon">{'\uD83D\uDCAC'}</span>
      <div className="unified-timeline-line" />
      <div className="unified-timeline-content">
        <div className="unified-timeline-entry-header">
          <span className="badge badge-idle">comment</span>
          <span className="unified-timeline-agent">{comment.author}</span>
          <span className="unified-timeline-time">{formatTimePrecise(comment.createdAt)}</span>
        </div>
        <p className="unified-timeline-summary">{comment.text}</p>
      </div>
    </div>
  )
}

function LifecycleItem({ entry }: { entry: TimelineEntry }) {
  const label = entry.lifecycleLabel || 'event'
  return (
    <div className="unified-timeline-event unified-timeline-lifecycle">
      <span className="unified-timeline-icon">
        {LIFECYCLE_ICONS[label] || '\u25CB'}
      </span>
      <div className="unified-timeline-line" />
      <div className="unified-timeline-content">
        <div className="unified-timeline-entry-header">
          <span className={`badge badge-${LIFECYCLE_BADGE[label] || 'idle'}`}>
            {label}
          </span>
          <span className="unified-timeline-time">{formatTimePrecise(entry.ts)}</span>
        </div>
        {entry.lifecycleDetail && (
          <p className="unified-timeline-summary">{entry.lifecycleDetail}</p>
        )}
      </div>
    </div>
  )
}
