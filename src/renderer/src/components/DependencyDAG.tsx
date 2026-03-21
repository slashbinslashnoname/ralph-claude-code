import React, { useMemo } from 'react'
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

  return { nodes, edges: layoutEdges, width, height, beadMap }
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
  const { nodes, edges, width, height } = useMemo(
    () => computeLayout(beads),
    [beads],
  )

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      data-testid="dependency-dag"
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
      </defs>

      <g transform={`translate(${PADDING},${PADDING})`}>
        {edges.map((edge) => (
          <path
            key={`${edge.source}-${edge.target}`}
            d={pointsToPath(edge.points)}
            fill="none"
            stroke="#9ca3af"
            strokeWidth={1.5}
            markerEnd="url(#arrowhead)"
            data-testid="dag-edge"
          />
        ))}

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
  )
}
