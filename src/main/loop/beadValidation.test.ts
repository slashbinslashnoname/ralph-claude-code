import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  validateBeadId,
  validateStatusFilter,
  validatePriority,
  validateLabel,
  validateLabels,
  validateTitle,
  validateBeadType,
  validateDescription,
  validateProjectPath,
  validateBeadsList,
  validateBeadsCreate,
  validateBeadsUpdate,
  validateBeadsReorder,
} from './beadValidation'

// ── validateBeadId ──────────────────────────────────────────────────────────

describe('validateBeadId', () => {
  it('accepts simple slug IDs', () => {
    assert.equal(validateBeadId('sb-abc.1'), 'sb-abc.1')
    assert.equal(validateBeadId('task_42'), 'task_42')
    assert.equal(validateBeadId('a'), 'a')
    assert.equal(validateBeadId('ABC-123'), 'ABC-123')
  })

  it('rejects empty string', () => {
    assert.throws(() => validateBeadId(''), /non-empty/)
  })

  it('rejects non-string', () => {
    assert.throws(() => validateBeadId(123), /non-empty string/)
    assert.throws(() => validateBeadId(null), /non-empty string/)
    assert.throws(() => validateBeadId(undefined), /non-empty string/)
  })

  it('rejects IDs starting with non-alphanumeric', () => {
    assert.throws(() => validateBeadId('-abc'), /invalid characters/)
    assert.throws(() => validateBeadId('.abc'), /invalid characters/)
    assert.throws(() => validateBeadId('_abc'), /invalid characters/)
  })

  it('rejects IDs with shell metacharacters', () => {
    assert.throws(() => validateBeadId('abc;rm'), /invalid characters/)
    assert.throws(() => validateBeadId('abc$(cmd)'), /invalid characters/)
    assert.throws(() => validateBeadId('abc`cmd`'), /invalid characters/)
    assert.throws(() => validateBeadId('abc|pipe'), /invalid characters/)
    assert.throws(() => validateBeadId('abc&bg'), /invalid characters/)
  })

  it('rejects IDs longer than 128 chars', () => {
    assert.throws(() => validateBeadId('a'.repeat(129)), /invalid characters/)
  })

  it('accepts IDs up to 128 chars', () => {
    assert.equal(validateBeadId('a'.repeat(128)), 'a'.repeat(128))
  })

  it('uses custom field name in error', () => {
    assert.throws(() => validateBeadId('', 'beadId'), /beadId/)
  })
})

// ── validateStatusFilter ────────────────────────────────────────────────────

describe('validateStatusFilter', () => {
  it('defaults to open for undefined/null', () => {
    assert.equal(validateStatusFilter(undefined), 'open')
    assert.equal(validateStatusFilter(null), 'open')
  })

  it('accepts valid filters', () => {
    assert.equal(validateStatusFilter('open'), 'open')
    assert.equal(validateStatusFilter('closed'), 'closed')
    assert.equal(validateStatusFilter('in_progress'), 'in_progress')
    assert.equal(validateStatusFilter('all'), 'all')
  })

  it('normalizes case and whitespace', () => {
    assert.equal(validateStatusFilter('OPEN'), 'open')
    assert.equal(validateStatusFilter(' All '), 'all')
  })

  it('rejects invalid filter', () => {
    assert.throws(() => validateStatusFilter('invalid'), /Invalid filter/)
  })

  it('rejects non-string', () => {
    assert.throws(() => validateStatusFilter(42), /must be a string/)
  })
})

// ── validatePriority ────────────────────────────────────────────────────────

describe('validatePriority', () => {
  it('returns undefined for undefined/null', () => {
    assert.equal(validatePriority(undefined), undefined)
    assert.equal(validatePriority(null), undefined)
  })

  it('accepts valid priorities 0–4', () => {
    for (let i = 0; i <= 4; i++) {
      assert.equal(validatePriority(i), i)
    }
  })

  it('rejects out-of-range', () => {
    assert.throws(() => validatePriority(-1), /between 0 and 4/)
    assert.throws(() => validatePriority(5), /between 0 and 4/)
    assert.throws(() => validatePriority(100), /between 0 and 4/)
  })

  it('rejects non-integer', () => {
    assert.throws(() => validatePriority(1.5), /must be an integer/)
    assert.throws(() => validatePriority('abc'), /must be an integer/)
  })

  it('coerces numeric string', () => {
    assert.equal(validatePriority('3'), 3)
  })
})

// ── validateLabel ───────────────────────────────────────────────────────────

describe('validateLabel', () => {
  it('accepts simple labels', () => {
    assert.equal(validateLabel('frontend'), 'frontend')
    assert.equal(validateLabel('high-priority'), 'high-priority')
    assert.equal(validateLabel('v2.0'), 'v2.0')
    assert.equal(validateLabel('my label'), 'my label')
  })

  it('rejects empty string', () => {
    assert.throws(() => validateLabel(''), /non-empty/)
  })

  it('rejects commas', () => {
    assert.throws(() => validateLabel('a,b'), /invalid/)
  })

  it('rejects shell metacharacters', () => {
    assert.throws(() => validateLabel('label;rm'), /invalid/)
    assert.throws(() => validateLabel('$(cmd)'), /invalid/)
  })

  it('rejects labels over 64 chars', () => {
    assert.throws(() => validateLabel('a'.repeat(65)), /invalid/)
  })
})

// ── validateLabels ──────────────────────────────────────────────────────────

describe('validateLabels', () => {
  it('returns undefined for undefined/null', () => {
    assert.equal(validateLabels(undefined), undefined)
    assert.equal(validateLabels(null), undefined)
  })

  it('validates each label in array', () => {
    assert.deepEqual(validateLabels(['a', 'b']), ['a', 'b'])
  })

  it('rejects non-array', () => {
    assert.throws(() => validateLabels('notarray'), /must be an array/)
  })

  it('rejects array with invalid label', () => {
    assert.throws(() => validateLabels(['ok', 'bad;one']), /invalid/)
  })
})

// ── validateTitle ───────────────────────────────────────────────────────────

describe('validateTitle', () => {
  it('accepts valid titles', () => {
    assert.equal(validateTitle('Fix login bug'), 'Fix login bug')
  })

  it('rejects empty/whitespace', () => {
    assert.throws(() => validateTitle(''), /non-empty/)
    assert.throws(() => validateTitle('   '), /non-empty/)
  })

  it('rejects non-string', () => {
    assert.throws(() => validateTitle(42), /non-empty string/)
  })

  it('rejects titles over 512 chars', () => {
    assert.throws(() => validateTitle('x'.repeat(513)), /512 characters/)
  })

  it('accepts title at limit', () => {
    assert.equal(validateTitle('x'.repeat(512)), 'x'.repeat(512))
  })
})

// ── validateBeadType ────────────────────────────────────────────────────────

describe('validateBeadType', () => {
  it('returns undefined for undefined/null', () => {
    assert.equal(validateBeadType(undefined), undefined)
    assert.equal(validateBeadType(null), undefined)
  })

  it('accepts valid types', () => {
    for (const t of ['epic', 'task', 'subtask', 'bug', 'feature']) {
      assert.equal(validateBeadType(t), t)
    }
  })

  it('rejects invalid type', () => {
    assert.throws(() => validateBeadType('invalid'), /Invalid type/)
  })
})

// ── validateDescription ─────────────────────────────────────────────────────

describe('validateDescription', () => {
  it('returns undefined for undefined/null', () => {
    assert.equal(validateDescription(undefined), undefined)
    assert.equal(validateDescription(null), undefined)
  })

  it('accepts valid description', () => {
    assert.equal(validateDescription('Some desc'), 'Some desc')
  })

  it('rejects non-string', () => {
    assert.throws(() => validateDescription(42), /must be a string/)
  })

  it('rejects over 10000 chars', () => {
    assert.throws(() => validateDescription('x'.repeat(10_001)), /10000 characters/)
  })
})

// ── validateProjectPath ─────────────────────────────────────────────────────

describe('validateProjectPath', () => {
  it('accepts valid paths', () => {
    assert.equal(validateProjectPath('/home/user/project'), '/home/user/project')
  })

  it('rejects empty/non-string', () => {
    assert.throws(() => validateProjectPath(''), /non-empty/)
    assert.throws(() => validateProjectPath(null), /non-empty string/)
    assert.throws(() => validateProjectPath(undefined), /non-empty string/)
  })
})

// ── Composite: validateBeadsList ────────────────────────────────────────────

describe('validateBeadsList', () => {
  it('returns validated projectPath and default filter', () => {
    const r = validateBeadsList('/proj', undefined)
    assert.equal(r.projectPath, '/proj')
    assert.equal(r.filter, 'open')
  })

  it('validates custom filter', () => {
    const r = validateBeadsList('/proj', 'all')
    assert.equal(r.filter, 'all')
  })

  it('throws on invalid filter', () => {
    assert.throws(() => validateBeadsList('/proj', 'nope'), /Invalid filter/)
  })
})

// ── Composite: validateBeadsCreate ──────────────────────────────────────────

describe('validateBeadsCreate', () => {
  it('validates a minimal create', () => {
    const r = validateBeadsCreate('/proj', { title: 'Hello' })
    assert.equal(r.opts.title, 'Hello')
    assert.equal(r.opts.priority, undefined)
  })

  it('validates full create opts', () => {
    const r = validateBeadsCreate('/proj', {
      title: 'Fix bug',
      type: 'bug',
      priority: 1,
      description: 'desc',
      labels: ['urgent'],
    })
    assert.equal(r.opts.type, 'bug')
    assert.equal(r.opts.priority, 1)
    assert.deepEqual(r.opts.labels, ['urgent'])
  })

  it('throws on missing title', () => {
    assert.throws(() => validateBeadsCreate('/proj', {}), /title/)
  })

  it('throws on invalid priority', () => {
    assert.throws(() => validateBeadsCreate('/proj', { title: 'x', priority: 9 }), /between/)
  })

  it('throws on non-object opts', () => {
    assert.throws(() => validateBeadsCreate('/proj', 'bad'), /must be an object/)
    assert.throws(() => validateBeadsCreate('/proj', null), /must be an object/)
  })
})

// ── Composite: validateBeadsUpdate ──────────────────────────────────────────

describe('validateBeadsUpdate', () => {
  it('validates a simple update', () => {
    const r = validateBeadsUpdate('/proj', 'bead-1', { priority: 2 })
    assert.equal(r.id, 'bead-1')
    assert.equal(r.opts.priority, 2)
  })

  it('throws on invalid id', () => {
    assert.throws(() => validateBeadsUpdate('/proj', ';rm -rf', {}), /invalid characters/)
  })

  it('throws on invalid claim type', () => {
    assert.throws(() => validateBeadsUpdate('/proj', 'b1', { claim: 'yes' }), /must be a boolean/)
  })

  it('validates labels', () => {
    const r = validateBeadsUpdate('/proj', 'b1', { labelsAdd: ['ui'], labelsRemove: ['old'] })
    assert.deepEqual(r.opts.labelsAdd, ['ui'])
    assert.deepEqual(r.opts.labelsRemove, ['old'])
  })
})

// ── Composite: validateBeadsReorder ─────────────────────────────────────────

describe('validateBeadsReorder', () => {
  it('validates a list of IDs', () => {
    const r = validateBeadsReorder('/proj', ['a1', 'b2', 'c3'])
    assert.deepEqual(r.ids, ['a1', 'b2', 'c3'])
  })

  it('throws on non-array', () => {
    assert.throws(() => validateBeadsReorder('/proj', 'abc'), /must be an array/)
  })

  it('throws on empty array', () => {
    assert.throws(() => validateBeadsReorder('/proj', []), /must not be empty/)
  })

  it('throws on invalid ID in array', () => {
    assert.throws(() => validateBeadsReorder('/proj', ['ok', ';bad']), /invalid characters/)
  })

  it('includes index in error for invalid ID', () => {
    assert.throws(() => validateBeadsReorder('/proj', ['ok', ';bad']), /ids\[1\]/)
  })
})
