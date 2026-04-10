import React, { useState, useEffect, useCallback } from 'react'
import { AsyncButton } from './AsyncButton'
import { formatTime } from '../utils/formatTime'
import type { BdComment } from '../types/ipc'

interface Props {
  beadId: string
  projectPath: string
}

export default function CommentThread({ beadId, projectPath }: Props) {
  const [comments, setComments] = useState<BdComment[]>([])
  const [loading, setLoading] = useState(true)
  const [newComment, setNewComment] = useState('')

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      const result = await window.slashbot.beads.comments(projectPath, beadId)
      setComments(Array.isArray(result) ? result : [])
    } catch {
      setComments([])
    }
    setLoading(false)
  }, [projectPath, beadId])

  useEffect(() => { refresh() }, [refresh])

  const addComment = useCallback(async () => {
    if (!newComment.trim()) return
    await window.slashbot.beads.addComment(projectPath, beadId, newComment.trim())
    setNewComment('')
    await refresh()
  }, [projectPath, beadId, newComment, refresh])

  if (loading) {
    return (
      <div className="comment-thread">
        <p className="comment-thread-loading">Loading comments...</p>
      </div>
    )
  }

  return (
    <div className="comment-thread">
      <div className="comment-thread-header">
        <span className="comment-thread-title">Comments ({comments.length})</span>
      </div>

      {comments.length === 0 ? (
        <p className="comment-thread-empty">No comments yet</p>
      ) : (
        <div className="comment-list">
          {comments.map(comment => (
            <div key={comment.id} className="comment-item">
              <div className="comment-meta">
                <span className="comment-author">{comment.author}</span>
                <span className="comment-time">{formatTime(comment.createdAt)}</span>
              </div>
              <p className="comment-text">{comment.text}</p>
            </div>
          ))}
        </div>
      )}

      <div className="comment-input-area">
        <textarea
          className="textarea comment-textarea"
          placeholder="Add a comment..."
          rows={2}
          value={newComment}
          onChange={e => setNewComment(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && e.metaKey) addComment() }}
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
