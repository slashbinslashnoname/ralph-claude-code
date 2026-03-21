import React, { useMemo, useState, useCallback, useRef } from 'react'
import dagre from 'dagre'

type BeadStatus = 'pending' | 'ready' | 'claimed' | 'done' | 'failed'

export interface DAGBead {
  id: string
  title: string
  status: BeadStatus
  deps: string[]
  epicId?: string
}

interface DependencyDAGProps {
  beads: DAGBead[]
}

interface ViewBox {
  x: number
  y: number
  w: number
  h: number
}

const STATUS_COLORS: Record<BeadStatus, string> = {
  pending: '#6b7280',
  ready: '#3b82f6',
  claimed: '#f59e0b',
  done: '#10b981',
  failed: '#ef4444',
}

const NODE_WIDTH = 160
const NODE_HEIGHT = 50
const PADDING = 20
const ZOOM_FACTOR = 0.1
const MIN_ZOOM = 0.2
const MAX_ZOOM = 5

/**
 * Detect cycles via DFS and return the set of back-edges to break.
 */
function findBackEdges(
  adjacency: Map<string, string[]>,
  nodeIds: Set<string>,
): Set<string> {
  const visiting = new Set<string>()
  const visited = new Set<string>()
  const backEdges = new Set<string>()

  function dfs(node: string): void {
    visiting.add(node)
    for (const neighbor of adjacency.get(node) ?? []) {
      if (visiting.has(neighbor)) {
        backEdges.add(`${node}->${neighbor}`)
      } else if (!visited.has(neighbor)) {
        dfs(neighbor)
      }
    }
    visiting.delete(node)
    visited.add(node)
  }

  for (const id of nodeIds) {
    if (!visited.has(id)) {
      dfs(id)
    }
  }

  return backEdges
}

/**
 * Compute the critical path (longest path) in the DAG via DFS from root nodes.
 * Returns a set of edge keys "source->target" that lie on the critical path.
 */
export function findCriticalPath(
  edges: Array<[string, string]>,
  nodeIds: Set<string>,
): Set<string> {
  if (edges.length === 0 || nodeIds.size === 0) return new Set()

  // Build adjacency (source -> targets) for forward traversal
  const children = new Map<string, string[]>()
  const inDegree = new Map<string, number>()
  for (const id of nodeIds) {
    children.set(id, [])
    inDegree.set(id, 0)
  }
  for (const [source, target] of edges) {
    children.get(source)!.push(target)
    inDegree.set(target, (inDegree.get(target) ?? 0) + 1)
  }

  // Root nodes: no incoming edges
  const roots = [...nodeIds].filter((id) => (inDegree.get(id) ?? 0) === 0)
  if (roots.length === 0) return new Set()

  // DFS to compute longest distance and predecessor for each node
  const dist = new Map<string, number>()
  const pred = new Map<string, string | null>()
  for (const id of nodeIds) {
    dist.set(id, -1)
    pred.set(id, null)
  }

  function dfs(node: string, depth: number): void {
    if (depth > dist.get(node)!) {
      dist.set(node, depth)
    }
    for (const child of children.get(node) ?? []) {
      const newDist = depth + 1
      if (newDist > dist.get(child)!) {
        dist.set(child, newDist)
        pred.set(child, node)
        dfs(child, newDist)
      }
    }
  }

  for (const root of roots) {
    dfs(root, 0)
  }

  // Find the node with maximum distance
  let maxDist = -1
  let endNode: string | null = null
  for (const [id, d] of dist) {
    if (d > maxDist) {
      maxDist = d
      endNode = id
    }
  }

  if (endNode === null || maxDist <= 0) return new Set()

  // Trace back from endNode to root via pred pointers
  const criticalEdges = new Set<string>()
  let current: string | null = endNode
  while (current !== null) {
    const parent = pred.get(current) ?? null
    if (parent !== null) {
      criticalEdges.add(`${parent}->${current}`)
    }
    current = parent
  }

  return criticalEdges
}

function computeLayout(beads: DAGBead[]) {
  const beadMap = new Map(beads.map((b) => [b.id, b]))
  const nodeIds = new Set(beads.map((b) => b.id))

  // Build adjacency for cycle detection (source -> target)
  const adjacency = new Map<string, string[]>()
  for (const bead of beads) {
    const edges: string[] = []
    for (const dep of bead.deps) {
      if (nodeIds.has(dep)) edges.push(dep)
    }
    if (bead.epicId && nodeIds.has(bead.epicId)) {
      edges.push(bead.epicId)
    }
    adjacency.set(bead.id, edges)
  }

  // Note: edges go from child -> dep (dep is upstream).
  // For the DAG we want dep above child, so edge direction is dep -> child in dagre.
  // Build raw edges as [source=dep, target=child]
  const rawEdges: Array<[string, string]> = []
  for (const bead of beads) {
    for (const dep of bead.deps) {
      if (nodeIds.has(dep)) {
        rawEdges.push([dep, bead.id])
      }
    }
    if (bead.epicId && nodeIds.has(bead.epicId)) {
      rawEdges.push([bead.epicId, bead.id])
    }
  }

  // Detect back-edges using the adjacency (child -> dep direction)
  const backEdges = findBackEdges(adjacency, nodeIds)

  // Filter out back-edges (translating: adjacency edge child->dep becomes dagre edge dep->child)
  const edges = rawEdges.filter(([source, target]) => {
    // The adjacency back-edge would be target->source (child->dep)
    return !backEdges.has(`${target}->${source}`)
  })

  const g = new dagre.graphlib.Graph()
  g.setGraph({ rankdir: 'TB', nodesep: 30, ranksep: 50 })
  g.setDefaultEdgeLabel(() => ({}))

  for (const bead of beads) {
    g.setNode(bead.id, { width: NODE_WIDTH, height: NODE_HEIGHT })
  }

  for (const [source, target] of edges) {
    g.setEdge(source, target)
  }

  dagre.layout(g)

  const nodes = beads.map((bead) => {
    const node = g.node(bead.id)
    return {
      ...bead,
      x: node.x - NODE_WIDTH / 2,
      y: node.y - NODE_HEIGHT / 2,
      cx: node.x,
      cy: node.y,
    }
  })

  const layoutEdges = edges.map(([source, target]) => {
    const points = g.edge(source, target).points ?? []
    return { source, target, points }
  })

  const graph = g.graph()
  const width = (graph.width ?? 300) + PADDING * 2
  const height = (graph.height ?? 200) + PADDING * 2

  // Compute critical path
  const criticalEdges = findCriticalPath(edges, nodeIds)

  return { nodes, edges: layoutEdges, width, height, beadMap, criticalEdges }
}

function pointsToPath(points: Array<{ x: number; y: number }>): string {
  if (points.length === 0) return ''
  if (points.length === 1) return `M${points[0].x},${points[0].y}`
  const [first, ...rest] = points
  if (rest.length === 1) {
    return `M${first.x},${first.y}L${rest[0].x},${rest[0].y}`
  }
  // Use cubic bezier for smooth curves
  let d = `M${first.x},${first.y}`
  for (let i = 0; i < rest.length - 1; i += 2) {
    const cp = rest[i]
    const end = rest[i + 1] ?? cp
    d += `Q${cp.x},${cp.y} ${end.x},${end.y}`
  }
  return d
}

function truncate(text: string, maxLen: number): string {
  return text.length > maxLen ? text.slice(0, maxLen - 1) + '\u2026' : text
}

export default function DependencyDAG({ beads }: DependencyDAGProps) {
  const { nodes, edges, width, height, criticalEdges } = useMemo(
    () => computeLayout(beads),
    [beads],
  )

  const defaultViewBox: ViewBox = useMemo(
    () => ({ x: 0, y: 0, w: width, h: height }),
    [width, height],
  )

  const [viewBox, setViewBox] = useState<ViewBox>(defaultViewBox)
  const [isPanning, setIsPanning] = useState(false)
  const panStart = useRef<{ x: number; y: number; vbX: number; vbY: number } | null>(null)
  const svgRef = useRef<SVGSVGElement>(null)
  const zoomTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pendingZoom = useRef<ViewBox | null>(null)

  // Reset viewBox when layout changes
  const prevSize = useRef({ w: width, h: height })
  if (prevSize.current.w !== width || prevSize.current.h !== height) {
    prevSize.current = { w: width, h: height }
    // Will be picked up on next render
    if (viewBox.x === 0 && viewBox.y === 0) {
      // Only auto-reset if user hasn't panned
    }
  }

  const handleWheel = useCallback(
    (e: React.WheelEvent<SVGSVGElement>) => {
      e.preventDefault()
      const svg = svgRef.current
      if (!svg) return

      const rect = svg.getBoundingClientRect()
      // Mouse position as fraction of SVG element
      const mx = (e.clientX - rect.left) / rect.width
      const my = (e.clientY - rect.top) / rect.height

      const current = pendingZoom.current ?? viewBox
      const direction = e.deltaY > 0 ? 1 : -1
      const factor = 1 + direction * ZOOM_FACTOR

      const newW = Math.max(
        width / MAX_ZOOM,
        Math.min(width / MIN_ZOOM, current.w * factor),
      )
      const newH = Math.max(
        height / MAX_ZOOM,
        Math.min(height / MIN_ZOOM, current.h * factor),
      )

      // Zoom toward mouse position
      const newX = current.x + (current.w - newW) * mx
      const newY = current.y + (current.h - newH) * my

      const next = { x: newX, y: newY, w: newW, h: newH }
      pendingZoom.current = next

      // Debounce: apply after 16ms of no wheel events
      if (zoomTimer.current) clearTimeout(zoomTimer.current)
      zoomTimer.current = setTimeout(() => {
        if (pendingZoom.current) {
          setViewBox(pendingZoom.current)
          pendingZoom.current = null
        }
      }, 16)
    },
    [viewBox, width, height],
  )

  const handleMouseDown = useCallback(
    (e: React.MouseEvent<SVGSVGElement>) => {
      if (e.button !== 0) return
      setIsPanning(true)
      panStart.current = { x: e.clientX, y: e.clientY, vbX: viewBox.x, vbY: viewBox.y }
    },
    [viewBox],
  )

  const handleMouseMove = useCallback(
    (e: React.MouseEvent<SVGSVGElement>) => {
      if (!isPanning || !panStart.current || !svgRef.current) return
      const rect = svgRef.current.getBoundingClientRect()
      // Convert pixel delta to viewBox coordinate delta
      const dx = ((e.clientX - panStart.current.x) / rect.width) * viewBox.w
      const dy = ((e.clientY - panStart.current.y) / rect.height) * viewBox.h
      setViewBox({
        ...viewBox,
        x: panStart.current.vbX - dx,
        y: panStart.current.vbY - dy,
      })
    },
    [isPanning, viewBox],
  )

  const handleMouseUp = useCallback(() => {
    setIsPanning(false)
    panStart.current = null
  }, [])

  const handleReset = useCallback(() => {
    setViewBox({ x: 0, y: 0, w: width, h: height })
    pendingZoom.current = null
  }, [width, height])

  const vb = `${viewBox.x} ${viewBox.y} ${viewBox.w} ${viewBox.h}`

  return (
    <div style={{ position: 'relative', display: 'inline-block' }}>
      <svg
        ref={svgRef}
        width={width}
        height={height}
        viewBox={vb}
        data-testid="dependency-dag"
        onWheel={handleWheel}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseUp}
        style={{ cursor: isPanning ? 'grabbing' : 'grab' }}
      >
        <defs>
          <marker
            id="arrowhead"
            markerWidth="8"
            markerHeight="6"
            refX="8"
            refY="3"
            orient="auto"
          >
            <polygon points="0 0, 8 3, 0 6" fill="#9ca3af" />
          </marker>
          <marker
            id="arrowhead-critical"
            markerWidth="8"
            markerHeight="6"
            refX="8"
            refY="3"
            orient="auto"
          >
            <polygon points="0 0, 8 3, 0 6" fill="#f97316" />
          </marker>
        </defs>

        <g transform={`translate(${PADDING},${PADDING})`}>
          {edges.map((edge) => {
            const isCritical = criticalEdges.has(`${edge.source}->${edge.target}`)
            return (
              <path
                key={`${edge.source}-${edge.target}`}
                d={pointsToPath(edge.points)}
                fill="none"
                stroke={isCritical ? '#f97316' : '#9ca3af'}
                strokeWidth={isCritical ? 3 : 1.5}
                markerEnd={isCritical ? 'url(#arrowhead-critical)' : 'url(#arrowhead)'}
                className={isCritical ? 'dag-critical' : undefined}
                data-testid="dag-edge"
              />
            )
          })}

          {nodes.map((node) => (
            <g key={node.id} transform={`translate(${node.x},${node.y})`}>
              <rect
                width={NODE_WIDTH}
                height={NODE_HEIGHT}
                rx={8}
                ry={8}
                fill={STATUS_COLORS[node.status]}
                opacity={0.9}
                data-testid="dag-node"
                data-status={node.status}
              />
              <text
                x={NODE_WIDTH / 2}
                y={20}
                textAnchor="middle"
                fill="white"
                fontSize={12}
                fontWeight="bold"
              >
                {truncate(node.title, 18)}
              </text>
              <text
                x={NODE_WIDTH / 2}
                y={38}
                textAnchor="middle"
                fill="rgba(255,255,255,0.7)"
                fontSize={10}
              >
                {node.id}
              </text>
            </g>
          ))}
        </g>
      </svg>
      <button
        onClick={handleReset}
        data-testid="dag-reset-view"
        style={{
          position: 'absolute',
          top: 8,
          right: 8,
          padding: '4px 8px',
          fontSize: 12,
          background: '#374151',
          color: '#e5e7eb',
          border: '1px solid #4b5563',
          borderRadius: 4,
          cursor: 'pointer',
        }}
      >
        Reset View
      </button>
    </div>
  )
}
