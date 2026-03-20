import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  validateWorkerCount,
  validatePlanRequest,
  validateAgentId,
  validateActivityLimit,
  validateLogFilename,
  validateQueueId,
  validateSwarmStart,
  validateSwarmStop,
  validateSwarmInject,
  validateSwarmQueueRemove,
  validateSwarmQueue,
  validateSwarmStatus,
  validateSwarmBeads,
  validateSwarmBeadStats,
  validateSwarmAgentLogs,
  validateSwarmActivity,
  validateSwarmAgentOutput,
  validateSwarmAgentLogContent,
} from './swarmValidation'

// ── validateWorkerCount ────────────────────────────────────────────────────

describe('validateWorkerCount', () => {
  it('defaults to 2 for undefined/null', () => {
    assert.equal(validateWorkerCount(undefined), 2)
    assert.equal(validateWorkerCount(null), 2)
  })

  it('accepts valid counts', () => {
    assert.equal(validateWorkerCount(1), 1)
    assert.equal(validateWorkerCount(4), 4)
    assert.equal(validateWorkerCount(8), 8)
  })

  it('accepts string numbers', () => {
    assert.equal(validateWorkerCount('3'), 3)
  })

  it('rejects zero', () => {
    assert.throws(() => validateWorkerCount(0), /between 1 and 8/)
  })

  it('rejects values above max', () => {
    assert.throws(() => validateWorkerCount(9), /between 1 and 8/)
    assert.throws(() => validateWorkerCount(100), /between 1 and 8/)
  })

  it('rejects non-integer', () => {
    assert.throws(() => validateWorkerCount(2.5), /integer/)
    assert.throws(() => validateWorkerCount('abc'), /integer/)
  })

  it('rejects non-number types', () => {
    assert.throws(() => validateWorkerCount(true), /integer/)
    assert.throws(() => validateWorkerCount({}), /integer/)
  })
})

// ── validatePlanRequest ──────────────────────────────────────────────────────

describe('validatePlanRequest', () => {
  it('accepts valid plan text', () => {
    assert.equal(validatePlanRequest('Build a REST API'), 'Build a REST API')
  })

  it('rejects empty string', () => {
    assert.throws(() => validatePlanRequest(''), /non-empty/)
  })

  it('rejects whitespace-only string', () => {
    assert.throws(() => validatePlanRequest('   '), /non-empty/)
  })

  it('rejects non-string', () => {
    assert.throws(() => validatePlanRequest(123), /non-empty string/)
    assert.throws(() => validatePlanRequest(null), /non-empty string/)
    assert.throws(() => validatePlanRequest(undefined), /non-empty string/)
  })

  it('rejects text exceeding max length', () => {
    assert.throws(() => validatePlanRequest('x'.repeat(50_001)), /50000 characters/)
  })

  it('accepts text at max length', () => {
    const text = 'x'.repeat(50_000)
    assert.equal(validatePlanRequest(text), text)
  })
})

// ── validateAgentId ──────────────────────────────────────────────────────────

describe('validateAgentId', () => {
  it('accepts valid agent IDs', () => {
    assert.equal(validateAgentId('agent-0'), 'agent-0')
    assert.equal(validateAgentId('agent-1'), 'agent-1')
    assert.equal(validateAgentId('agent-12'), 'agent-12')
    assert.equal(validateAgentId('agent-100'), 'agent-100')
  })

  it('rejects empty string', () => {
    assert.throws(() => validateAgentId(''), /non-empty/)
  })

  it('rejects non-string', () => {
    assert.throws(() => validateAgentId(0), /non-empty string/)
    assert.throws(() => validateAgentId(null), /non-empty string/)
    assert.throws(() => validateAgentId(undefined), /non-empty string/)
  })

  it('rejects IDs not matching agent-N pattern', () => {
    assert.throws(() => validateAgentId('worker-0'), /agent-N/)
    assert.throws(() => validateAgentId('agent-'), /agent-N/)
    assert.throws(() => validateAgentId('agent-abc'), /agent-N/)
    assert.throws(() => validateAgentId('0'), /agent-N/)
  })

  it('rejects path traversal attempts', () => {
    assert.throws(() => validateAgentId('../etc/passwd'), /agent-N/)
    assert.throws(() => validateAgentId('agent-0/../../etc'), /agent-N/)
  })

  it('rejects shell injection attempts', () => {
    assert.throws(() => validateAgentId('agent-0;rm -rf /'), /agent-N/)
    assert.throws(() => validateAgentId('agent-0$(cmd)'), /agent-N/)
    assert.throws(() => validateAgentId('agent-0`cmd`'), /agent-N/)
  })

  it('rejects IDs with too many digits', () => {
    assert.throws(() => validateAgentId('agent-1234'), /agent-N/)
  })
})

// ── validateActivityLimit ────────────────────────────────────────────────────

describe('validateActivityLimit', () => {
  it('defaults to 50 for undefined/null', () => {
    assert.equal(validateActivityLimit(undefined), 50)
    assert.equal(validateActivityLimit(null), 50)
  })

  it('accepts valid limits', () => {
    assert.equal(validateActivityLimit(1), 1)
    assert.equal(validateActivityLimit(100), 100)
    assert.equal(validateActivityLimit(1000), 1000)
  })

  it('rejects zero', () => {
    assert.throws(() => validateActivityLimit(0), /between 1 and 1000/)
  })

  it('rejects values above max', () => {
    assert.throws(() => validateActivityLimit(1001), /between 1 and 1000/)
  })

  it('rejects non-integer', () => {
    assert.throws(() => validateActivityLimit(1.5), /integer/)
  })
})

// ── validateLogFilename ──────────────────────────────────────────────────────

describe('validateLogFilename', () => {
  it('accepts valid log filenames', () => {
    assert.equal(
      validateLogFilename('agent-0_think_2024-01-15-10-30-00.log'),
      'agent-0_think_2024-01-15-10-30-00.log'
    )
    assert.equal(
      validateLogFilename('agent-1_execute_2024-01-15-10-30-00.log'),
      'agent-1_execute_2024-01-15-10-30-00.log'
    )
    assert.equal(
      validateLogFilename('agent-2_review_2024-01-15-10-30-00.log'),
      'agent-2_review_2024-01-15-10-30-00.log'
    )
  })

  it('rejects empty string', () => {
    assert.throws(() => validateLogFilename(''), /non-empty/)
  })

  it('rejects path traversal', () => {
    assert.throws(() => validateLogFilename('../secrets.log'), /path separators/)
    assert.throws(() => validateLogFilename('..\\secrets.log'), /path separators/)
    assert.throws(() => validateLogFilename('subdir/agent-0_think_ts.log'), /path separators/)
  })

  it('rejects non-matching filenames', () => {
    assert.throws(() => validateLogFilename('random.txt'), /agent log format/)
    assert.throws(() => validateLogFilename('agent-0.log'), /agent log format/)
    assert.throws(() => validateLogFilename('agent-0_invalid_ts.log'), /agent log format/)
  })
})

// ── validateQueueId ──────────────────────────────────────────────────────────

describe('validateQueueId', () => {
  it('accepts valid queue IDs', () => {
    assert.equal(validateQueueId('abc-123'), 'abc-123')
    assert.equal(validateQueueId('plan_001'), 'plan_001')
  })

  it('rejects empty string', () => {
    assert.throws(() => validateQueueId(''), /non-empty/)
  })

  it('rejects non-string', () => {
    assert.throws(() => validateQueueId(42), /non-empty string/)
    assert.throws(() => validateQueueId(null), /non-empty string/)
  })

  it('rejects IDs with invalid chars', () => {
    assert.throws(() => validateQueueId('id;drop'), /invalid characters/)
    assert.throws(() => validateQueueId('id/../../etc'), /invalid characters/)
  })

  it('rejects IDs exceeding 64 chars', () => {
    assert.throws(() => validateQueueId('a'.repeat(65)), /invalid characters/)
  })
})

// ── Composite validators ───────────────────────────────────────────────────

describe('validateSwarmStart', () => {
  it('validates and returns projectPath and workerCount', () => {
    const result = validateSwarmStart('/path/to/project', 4)
    assert.deepEqual(result, { projectPath: '/path/to/project', workerCount: 4 })
  })

  it('uses default workerCount', () => {
    const result = validateSwarmStart('/path/to/project', undefined)
    assert.equal(result.workerCount, 2)
  })

  it('rejects invalid projectPath', () => {
    assert.throws(() => validateSwarmStart('', 2), /projectPath/)
  })

  it('rejects invalid workerCount', () => {
    assert.throws(() => validateSwarmStart('/path', 20), /between 1 and 8/)
  })
})

describe('validateSwarmStop', () => {
  it('validates projectPath', () => {
    const result = validateSwarmStop('/path/to/project')
    assert.deepEqual(result, { projectPath: '/path/to/project' })
  })

  it('rejects invalid projectPath', () => {
    assert.throws(() => validateSwarmStop(''), /projectPath/)
  })
})

describe('validateSwarmInject', () => {
  it('validates projectPath and request', () => {
    const result = validateSwarmInject('/path', 'Build an API')
    assert.deepEqual(result, { projectPath: '/path', request: 'Build an API' })
  })

  it('rejects empty request', () => {
    assert.throws(() => validateSwarmInject('/path', ''), /non-empty/)
  })

  it('rejects invalid projectPath', () => {
    assert.throws(() => validateSwarmInject('', 'plan'), /projectPath/)
  })
})

describe('validateSwarmQueueRemove', () => {
  it('validates projectPath and id', () => {
    const result = validateSwarmQueueRemove('/path', 'plan-123')
    assert.deepEqual(result, { projectPath: '/path', id: 'plan-123' })
  })

  it('rejects invalid id', () => {
    assert.throws(() => validateSwarmQueueRemove('/path', ''), /non-empty/)
  })
})

describe('validateSwarmActivity', () => {
  it('validates projectPath and limit', () => {
    const result = validateSwarmActivity('/path', 100)
    assert.deepEqual(result, { projectPath: '/path', limit: 100 })
  })

  it('uses default limit', () => {
    const result = validateSwarmActivity('/path', undefined)
    assert.equal(result.limit, 50)
  })
})

describe('validateSwarmAgentOutput', () => {
  it('validates projectPath and agentId', () => {
    const result = validateSwarmAgentOutput('/path', 'agent-0')
    assert.deepEqual(result, { projectPath: '/path', agentId: 'agent-0' })
  })

  it('rejects path traversal in agentId', () => {
    assert.throws(() => validateSwarmAgentOutput('/path', '../etc'), /agent-N/)
  })
})

describe('validateSwarmAgentLogContent', () => {
  it('validates projectPath and filename', () => {
    const result = validateSwarmAgentLogContent('/path', 'agent-0_think_2024-01-01.log')
    assert.deepEqual(result, { projectPath: '/path', filename: 'agent-0_think_2024-01-01.log' })
  })

  it('rejects path traversal in filename', () => {
    assert.throws(() => validateSwarmAgentLogContent('/path', '../secrets'), /path separators/)
  })
})

describe('validateSwarmQueue', () => {
  it('validates projectPath', () => {
    const result = validateSwarmQueue('/path/to/project')
    assert.deepEqual(result, { projectPath: '/path/to/project' })
  })

  it('rejects invalid projectPath', () => {
    assert.throws(() => validateSwarmQueue(''), /projectPath/)
    assert.throws(() => validateSwarmQueue(null), /projectPath/)
  })
})

describe('validateSwarmStatus', () => {
  it('validates projectPath', () => {
    const result = validateSwarmStatus('/path/to/project')
    assert.deepEqual(result, { projectPath: '/path/to/project' })
  })

  it('rejects invalid projectPath', () => {
    assert.throws(() => validateSwarmStatus(''), /projectPath/)
  })
})

describe('validateSwarmBeads', () => {
  it('validates projectPath and status', () => {
    const result = validateSwarmBeads('/path', 'open')
    assert.deepEqual(result, { projectPath: '/path', status: 'open' })
  })

  it('defaults status to all', () => {
    const result = validateSwarmBeads('/path', undefined)
    assert.equal(result.status, 'all')
  })

  it('accepts all valid statuses', () => {
    assert.equal(validateSwarmBeads('/path', 'closed').status, 'closed')
    assert.equal(validateSwarmBeads('/path', 'in_progress').status, 'in_progress')
    assert.equal(validateSwarmBeads('/path', 'all').status, 'all')
  })

  it('rejects invalid status', () => {
    assert.throws(() => validateSwarmBeads('/path', 'invalid'), /Invalid filter/)
  })

  it('rejects invalid projectPath', () => {
    assert.throws(() => validateSwarmBeads('', 'open'), /projectPath/)
  })
})

describe('validateSwarmBeadStats', () => {
  it('validates projectPath', () => {
    const result = validateSwarmBeadStats('/path/to/project')
    assert.deepEqual(result, { projectPath: '/path/to/project' })
  })

  it('rejects invalid projectPath', () => {
    assert.throws(() => validateSwarmBeadStats(''), /projectPath/)
  })
})

describe('validateSwarmAgentLogs', () => {
  it('validates projectPath', () => {
    const result = validateSwarmAgentLogs('/path/to/project')
    assert.deepEqual(result, { projectPath: '/path/to/project' })
  })

  it('rejects invalid projectPath', () => {
    assert.throws(() => validateSwarmAgentLogs(''), /projectPath/)
    assert.throws(() => validateSwarmAgentLogs(null), /projectPath/)
  })
})
