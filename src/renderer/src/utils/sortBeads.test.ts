import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
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
    assert.deepEqual(result.map(b => b.priority), [0, 1, 2, 3])
  })

  it('sorts by priority descending (P3 first)', () => {
    const result = sortBeads(beads, 'priority', 'desc')
    assert.deepEqual(result.map(b => b.priority), [3, 2, 1, 0])
  })

  it('sorts by title ascending', () => {
    const result = sortBeads(beads, 'title', 'asc')
    assert.deepEqual(result.map(b => b.title), ['Alpha feature', 'Beta task', 'Mid task', 'Zebra fix'])
  })

  it('sorts by title descending', () => {
    const result = sortBeads(beads, 'title', 'desc')
    assert.deepEqual(result.map(b => b.title), ['Zebra fix', 'Mid task', 'Beta task', 'Alpha feature'])
  })

  it('sorts by status ascending (ready < claimed < pending < done)', () => {
    const result = sortBeads(beads, 'status', 'asc')
    assert.deepEqual(result.map(b => b.status), ['ready', 'claimed', 'pending', 'done'])
  })

  it('sorts by status descending', () => {
    const result = sortBeads(beads, 'status', 'desc')
    assert.deepEqual(result.map(b => b.status), ['done', 'pending', 'claimed', 'ready'])
  })

  it('sorts by type ascending', () => {
    const result = sortBeads(beads, 'type', 'asc')
    assert.deepEqual(result.map(b => b.type), ['bug', 'feature', 'task', 'task'])
  })

  it('does not mutate the original array', () => {
    const original = [...beads]
    sortBeads(beads, 'priority', 'desc')
    assert.deepEqual(beads, original)
  })

  it('handles beads with missing priority (defaults to 4)', () => {
    const input = [
      { id: 'x', title: 'No prio', status: 'ready', type: 'task' },
      { id: 'y', title: 'Has prio', priority: 1, status: 'ready', type: 'task' },
    ]
    const result = sortBeads(input, 'priority', 'asc')
    assert.equal(result[0].id, 'y')
    assert.equal(result[1].id, 'x')
  })

  it('handles empty array', () => {
    assert.deepEqual(sortBeads([], 'priority', 'asc'), [])
  })
})
