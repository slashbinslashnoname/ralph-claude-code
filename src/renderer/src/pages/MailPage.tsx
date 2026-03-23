import React from 'react'

interface MailPageProps {
  projectPath: string
}

export default function MailPage({ projectPath }: MailPageProps) {
  return (
    <div className="page-container">
      <h2>Mail</h2>
      <p className="text-muted">Inter-agent messages for {projectPath.split('/').pop()}</p>
    </div>
  )
}
