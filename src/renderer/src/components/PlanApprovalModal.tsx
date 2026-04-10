import React, { useState, useEffect } from 'react'

export interface PendingPlan {
  planMd: string
  request: string
  projectPath: string
}

export interface PlanApprovalModalProps {
  pendingPlan: PendingPlan | null
  onApprove: (projectPath: string, modified?: string) => void
  onReject: (projectPath: string) => void
}

export default function PlanApprovalModal({
  pendingPlan,
  onApprove,
  onReject,
}: PlanApprovalModalProps) {
  const [editedPlan, setEditedPlan] = useState('')

  useEffect(() => {
    if (pendingPlan) setEditedPlan(pendingPlan.planMd)
  }, [pendingPlan])

  if (!pendingPlan) return null

  const modified = editedPlan !== pendingPlan.planMd ? editedPlan : undefined

  return (
    <div className="plan-modal-backdrop">
      <div className="plan-modal" role="dialog" aria-label="Plan approval">
        <div className="plan-modal-header">
          <h3>Plan awaiting approval</h3>
          <span className="plan-review-request">{pendingPlan.request}</span>
        </div>
        <textarea
          className="plan-review-editor"
          value={editedPlan}
          onChange={e => setEditedPlan(e.target.value)}
          rows={Math.min(25, editedPlan.split('\n').length + 2)}
        />
        <div className="plan-review-actions">
          <button
            className="btn btn-primary"
            onClick={() => onApprove(pendingPlan.projectPath, modified)}
          >
            Approve Plan
          </button>
          <button
            className="btn btn-danger"
            onClick={() => onReject(pendingPlan.projectPath)}
          >
            Reject
          </button>
        </div>
      </div>
    </div>
  )
}
