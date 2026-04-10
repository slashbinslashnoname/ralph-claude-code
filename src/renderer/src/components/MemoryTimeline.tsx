import React from 'react'
import { formatTime } from '../utils/formatTime'
import type { BdMemory } from '../types/ipc'

interface Props {
  memory: BdMemory
}

/**
 * Lightweight timeline for memory cards, reusing the unified-timeline CSS classes
 * for visual consistency with bead timelines.
 */
export default function MemoryTimeline({ memory }: Props) {
  if (!memory.createdAt) return null

  return (
    <div className="unified-timeline memory-timeline">
      <div className="unified-timeline-entries">
        <div className="unified-timeline-event unified-timeline-lifecycle">
          <span className="unified-timeline-icon">{'\u2295'}</span>
          <div className="unified-timeline-line" />
          <div className="unified-timeline-content">
            <div className="unified-timeline-entry-header">
              <span className="badge badge-info">created</span>
              <span className="unified-timeline-time">
                {formatTime(memory.createdAt)}
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
