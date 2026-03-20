import { describe, it, expect } from 'vitest'
import { sortBeads } from './sortBeads'

const beads = [
  { id: 'a', title: 'Zebra fix', priority: 3, status: 'done', type: 'bug' },
  { id: 'b', title: 'Alpha feature', priority: 0, status: 'ready', type: 'feature' },
  { id: 'c', title: 'Mid task', priority: 2, status: 'claimed', type: 'task' },
  { id: 'd', title: 'Beta task', priority: 1, status: 'pending', type: 'task' },
]

describe('sortBeads', () => {
  it('sorts by priority ascending (P0 first)', () => {
    const result = sortBeads(beads, 'priority', 'asc')
    expect(result.map(b => b.priority)).toEqual([0, 1, 2, 3])
  })

  it('sorts by priority descending (P3 first)', () => {
    const result = sortBeads(beads, 'priority', 'desc')
    expect(result.map(b => b.priority)).toEqual([3, 2, 1, 0])
  })

  it('sorts by title ascending', () => {
    const result = sortBeads(beads, 'title', 'asc')
    expect(result.map(b => b.title)).toEqual(['Alpha feature', 'Beta task', 'Mid task', 'Zebra fix'])
  })

  it('sorts by title descending', () => {
    const result = sortBeads(beads, 'title', 'desc')
    expect(result.map(b => b.title)).toEqual(['Zebra fix', 'Mid task', 'Beta task', 'Alpha feature'])
  })

  it('sorts by status ascending (ready < claimed < pending < done)', () => {
    const result = sortBeads(beads, 'status', 'asc')
    expect(result.map(b => b.status)).toEqual(['ready', 'claimed', 'pending', 'done'])
  })

  it('sorts by status descending', () => {
    const result = sortBeads(beads, 'status', 'desc')
    expect(result.map(b => b.status)).toEqual(['done', 'pending', 'claimed', 'ready'])
  })

  it('sorts by type ascending', () => {
    const result = sortBeads(beads, 'type', 'asc')
    expect(result.map(b => b.type)).toEqual(['bug', 'feature', 'task', 'task'])
  })

  it('does not mutate the original array', () => {
    const original = [...beads]
    sortBeads(beads, 'priority', 'desc')
    expect(beads).toEqual(original)
  })

  it('handles beads with missing priority (defaults to 4)', () => {
    const input = [
      { id: 'x', title: 'No prio', status: 'ready', type: 'task' },
      { id: 'y', title: 'Has prio', priority: 1, status: 'ready', type: 'task' },
    ]
    const result = sortBeads(input, 'priority', 'asc')
    expect(result[0].id).toBe('y')
    expect(result[1].id).toBe('x')
  })

  it('handles empty array', () => {
    expect(sortBeads([], 'priority', 'asc')).toEqual([])
  })
})
