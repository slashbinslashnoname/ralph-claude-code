import React, { useState, useMemo, useCallback } from 'react'

type BeadStatus = 'pending' | 'ready' | 'claimed' | 'done' | 'failed'

export interface DAGBead {
  id: string
  title: string
  status: BeadStatus
  deps: string[]
  epicId?: string
}

interface TreeBrowserProps {
  beads: DAGBead[]
  selectedBeadId?: string | null
  onSelectBead?: (beadId: string) => void
}

/**
 * Build parent->children map from beads.
 * A child's parents are its deps + epicId.
 * We invert this to get: parent -> list of children.
 */
function buildChildrenMap(beads: DAGBead[]): Map<string, string[]> {
  const ids = new Set(beads.map(b => b.id))
  const childSets = new Map<string, Set<string>>()
  for (const id of ids) childSets.set(id, new Set())

  for (const bead of beads) {
    for (const dep of bead.deps) {
      if (ids.has(dep)) childSets.get(dep)!.add(bead.id)
    }
    if (bead.epicId && ids.has(bead.epicId)) {
      childSets.get(bead.epicId)!.add(bead.id)
    }
  }

  const children = new Map<string, string[]>()
  for (const [id, set] of childSets) children.set(id, [...set])
  return children
}

function findRoots(beads: DAGBead[]): string[] {
  const ids = new Set(beads.map(b => b.id))
  const hasParent = new Set<string>()

  for (const bead of beads) {
    for (const dep of bead.deps) {
      if (ids.has(dep)) hasParent.add(bead.id)
    }
    if (bead.epicId && ids.has(bead.epicId)) {
      hasParent.add(bead.id)
    }
  }

  return beads.filter(b => !hasParent.has(b.id)).map(b => b.id)
}

const STATUS_ICON: Record<string, string> = {
  done: '\u2713',
  failed: '\u2717',
  claimed: '\u25B6',
  ready: '\u25CB',
  pending: '\u25CC',
}

export default function TreeBrowser({ beads, selectedBeadId, onSelectBead }: TreeBrowserProps) {
  const [breadcrumb, setBreadcrumb] = useState<string[]>([])

  const beadMap = useMemo(() => new Map(beads.map(b => [b.id, b])), [beads])
  const childrenMap = useMemo(() => buildChildrenMap(beads), [beads])
  const roots = useMemo(() => findRoots(beads), [beads])

  const currentParentId = breadcrumb.length > 0 ? breadcrumb[breadcrumb.length - 1] : null
  const visibleIds = currentParentId ? (childrenMap.get(currentParentId) ?? []) : roots

  const drillDown = useCallback((id: string) => {
    const children = childrenMap.get(id) ?? []
    if (children.length > 0) {
      setBreadcrumb(prev => [...prev, id])
    }
  }, [childrenMap])

  const navigateTo = useCallback((index: number) => {
    // index -1 = root, 0 = first crumb, etc.
    if (index < 0) {
      setBreadcrumb([])
    } else {
      setBreadcrumb(prev => prev.slice(0, index + 1))
    }
  }, [])

  return (
    <div className="tree-browser" data-testid="tree-browser">
      {/* Breadcrumb */}
      <nav className="tree-breadcrumb" data-testid="tree-breadcrumb">
        <button
          className={`tree-crumb${breadcrumb.length === 0 ? ' tree-crumb-current' : ''}`}
          onClick={() => navigateTo(-1)}
          data-testid="tree-crumb-root"
        >
          Root
        </button>
        {breadcrumb.map((id, i) => {
          const bead = beadMap.get(id)
          const isCurrent = i === breadcrumb.length - 1
          return (
            <React.Fragment key={id}>
              <span className="tree-crumb-sep">/</span>
              <button
                className={`tree-crumb${isCurrent ? ' tree-crumb-current' : ''}`}
                onClick={() => navigateTo(i)}
                data-testid="tree-crumb"
              >
                {bead ? bead.title : id}
              </button>
            </React.Fragment>
          )
        })}
      </nav>

      {/* Node list */}
      <div className="tree-nodes" data-testid="tree-nodes">
        {visibleIds.length === 0 && (
          <div className="tree-empty" data-testid="tree-empty">
            {beads.length === 0 ? 'No beads' : 'No children'}
          </div>
        )}
        {visibleIds.map(id => {
          const bead = beadMap.get(id)
          if (!bead) return null
          const children = childrenMap.get(id) ?? []
          const hasChildren = children.length > 0
          const isSelected = selectedBeadId === id

          return (
            <div
              key={id}
              className={`tree-node${isSelected ? ' tree-node-selected' : ''}`}
              data-testid="tree-node"
              data-status={bead.status}
            >
              <div className="tree-node-header">
                <span className={`tree-node-status tree-status-${bead.status}`}>
                  {STATUS_ICON[bead.status] ?? '\u25CB'}
                </span>
                <span
                  className="tree-node-title"
                  onClick={() => onSelectBead?.(id)}
                  data-testid="tree-node-title"
                >
                  {bead.title}
                </span>
                <span className="tree-node-id">{bead.id}</span>
                {hasChildren && (
                  <button
                    className="tree-node-expand"
                    onClick={() => drillDown(id)}
                    data-testid="tree-node-expand"
                    title={`Browse ${children.length} children`}
                  >
                    {children.length} {'\u25B8'}
                  </button>
                )}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
