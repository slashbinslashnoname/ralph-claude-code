import { describe, it, expect } from 'vitest'
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
  validateSwarmPauseResume,
  validateSwarmKnowledge,
  validateBuildMonitorEnabled,
  validateSwarmBuildMonitorToggle,
  validateSwarmBuildMonitorStatus,
  validateSwarmActivityForBead,
  validateSwarmActivityForAgent,
} from './swarmValidation'

// ── validateWorkerCount ────────────────────────────────────────────────────

describe('validateWorkerCount', () => {
  it('defaults to 2 for undefined/null', () => {
    expect(validateWorkerCount(undefined)).toBe(2)
    expect(validateWorkerCount(null)).toBe(2)
  })

  it('accepts valid counts', () => {
    expect(validateWorkerCount(1)).toBe(1)
    expect(validateWorkerCount(4)).toBe(4)
    expect(validateWorkerCount(8)).toBe(8)
  })

  it('accepts string numbers', () => {
    expect(validateWorkerCount('3')).toBe(3)
  })

  it('rejects zero', () => {
    expect(() => validateWorkerCount(0)).toThrow(/between 1 and 8/)
  })

  it('rejects values above max', () => {
    expect(() => validateWorkerCount(9)).toThrow(/between 1 and 8/)
    expect(() => validateWorkerCount(100)).toThrow(/between 1 and 8/)
  })

  it('rejects non-integer', () => {
    expect(() => validateWorkerCount(2.5)).toThrow(/integer/)
    expect(() => validateWorkerCount('abc')).toThrow(/integer/)
  })

  it('rejects non-number types', () => {
    expect(() => validateWorkerCount(true)).toThrow(/integer/)
    expect(() => validateWorkerCount({})).toThrow(/integer/)
  })
})

// ── validatePlanRequest ──────────────────────────────────────────────────────

describe('validatePlanRequest', () => {
  it('accepts valid plan text', () => {
    expect(validatePlanRequest('Build a REST API')).toBe('Build a REST API')
  })

  it('rejects empty string', () => {
    expect(() => validatePlanRequest('')).toThrow(/non-empty/)
  })

  it('rejects whitespace-only string', () => {
    expect(() => validatePlanRequest('   ')).toThrow(/non-empty/)
  })

  it('rejects non-string', () => {
    expect(() => validatePlanRequest(123)).toThrow(/non-empty string/)
    expect(() => validatePlanRequest(null)).toThrow(/non-empty string/)
    expect(() => validatePlanRequest(undefined)).toThrow(/non-empty string/)
  })

  it('rejects text exceeding max length', () => {
    expect(() => validatePlanRequest('x'.repeat(50_001))).toThrow(/50000 characters/)
  })

  it('accepts text at max length', () => {
    const text = 'x'.repeat(50_000)
    expect(validatePlanRequest(text)).toBe(text)
  })
})

// ── validateAgentId ──────────────────────────────────────────────────────────

describe('validateAgentId', () => {
  it('accepts valid worker IDs with bead identifiers', () => {
    expect(validateAgentId('worker-0')).toBe('worker-0')
    expect(validateAgentId('worker-1')).toBe('worker-1')
    expect(validateAgentId('worker-ralph-claude-code-fhv')).toBe('worker-ralph-claude-code-fhv')
    expect(validateAgentId('worker-abc-123')).toBe('worker-abc-123')
    expect(validateAgentId('worker-a')).toBe('worker-a')
  })

  it('rejects empty string', () => {
    expect(() => validateAgentId('')).toThrow(/non-empty/)
  })

  it('rejects non-string', () => {
    expect(() => validateAgentId(0)).toThrow(/non-empty string/)
    expect(() => validateAgentId(null)).toThrow(/non-empty string/)
    expect(() => validateAgentId(undefined)).toThrow(/non-empty string/)
  })

  it('rejects IDs not matching worker-{id} pattern', () => {
    expect(() => validateAgentId('worker-0')).toThrow(/worker-/)
    expect(() => validateAgentId('worker-')).toThrow(/worker-/)
    expect(() => validateAgentId('0')).toThrow(/worker-/)
  })

  it('rejects path traversal attempts', () => {
    expect(() => validateAgentId('../etc/passwd')).toThrow(/worker-/)
    expect(() => validateAgentId('worker-0/../../etc')).toThrow(/worker-/)
  })

  it('rejects shell injection attempts', () => {
    expect(() => validateAgentId('worker-0;rm -rf /')).toThrow(/worker-/)
    expect(() => validateAgentId('worker-0$(cmd)')).toThrow(/worker-/)
    expect(() => validateAgentId('worker-0`cmd`')).toThrow(/worker-/)
  })
})

// ── validateActivityLimit ────────────────────────────────────────────────────

describe('validateActivityLimit', () => {
  it('defaults to 50 for undefined/null', () => {
    expect(validateActivityLimit(undefined)).toBe(50)
    expect(validateActivityLimit(null)).toBe(50)
  })

  it('accepts valid limits', () => {
    expect(validateActivityLimit(1)).toBe(1)
    expect(validateActivityLimit(100)).toBe(100)
    expect(validateActivityLimit(1000)).toBe(1000)
  })

  it('rejects zero', () => {
    expect(() => validateActivityLimit(0)).toThrow(/between 1 and 1000/)
  })

  it('rejects values above max', () => {
    expect(() => validateActivityLimit(1001)).toThrow(/between 1 and 1000/)
  })

  it('rejects non-integer', () => {
    expect(() => validateActivityLimit(1.5)).toThrow(/integer/)
  })
})

// ── validateLogFilename ──────────────────────────────────────────────────────

describe('validateLogFilename', () => {
  it('accepts valid log filenames', () => {
    expect(
      validateLogFilename('worker-0_think_2024-01-15-10-30-00.log')
    ).toBe('worker-0_think_2024-01-15-10-30-00.log')
    expect(
      validateLogFilename('worker-ralph-code-fhv_execute_2024-01-15-10-30-00.log')
    ).toBe('worker-ralph-code-fhv_execute_2024-01-15-10-30-00.log')
    expect(
      validateLogFilename('worker-abc-123_review_2024-01-15-10-30-00.log')
    ).toBe('worker-abc-123_review_2024-01-15-10-30-00.log')
  })

  it('rejects empty string', () => {
    expect(() => validateLogFilename('')).toThrow(/non-empty/)
  })

  it('rejects path traversal', () => {
    expect(() => validateLogFilename('../secrets.log')).toThrow(/path separators/)
    expect(() => validateLogFilename('..\\secrets.log')).toThrow(/path separators/)
    expect(() => validateLogFilename('subdir/worker-0_think_ts.log')).toThrow(/path separators/)
  })

  it('rejects non-matching filenames', () => {
    expect(() => validateLogFilename('random.txt')).toThrow(/worker log format/)
    expect(() => validateLogFilename('worker-0.log')).toThrow(/worker log format/)
    expect(() => validateLogFilename('worker-0_invalid_ts.log')).toThrow(/worker log format/)
  })
})

// ── validateQueueId ──────────────────────────────────────────────────────────

describe('validateQueueId', () => {
  it('accepts valid queue IDs', () => {
    expect(validateQueueId('abc-123')).toBe('abc-123')
    expect(validateQueueId('plan_001')).toBe('plan_001')
  })

  it('rejects empty string', () => {
    expect(() => validateQueueId('')).toThrow(/non-empty/)
  })

  it('rejects non-string', () => {
    expect(() => validateQueueId(42)).toThrow(/non-empty string/)
    expect(() => validateQueueId(null)).toThrow(/non-empty string/)
  })

  it('rejects IDs with invalid chars', () => {
    expect(() => validateQueueId('id;drop')).toThrow(/invalid characters/)
    expect(() => validateQueueId('id/../../etc')).toThrow(/invalid characters/)
  })

  it('rejects IDs exceeding 64 chars', () => {
    expect(() => validateQueueId('a'.repeat(65))).toThrow(/invalid characters/)
  })
})

// ── Composite validators ───────────────────────────────────────────────────

describe('validateSwarmStart', () => {
  it('validates and returns projectPath and workerCount', () => {
    const result = validateSwarmStart('/path/to/project', 4)
    expect(result).toEqual({ projectPath: '/path/to/project', workerCount: 4 })
  })

  it('uses default workerCount', () => {
    const result = validateSwarmStart('/path/to/project', undefined)
    expect(result.workerCount).toBe(2)
  })

  it('rejects invalid projectPath', () => {
    expect(() => validateSwarmStart('', 2)).toThrow(/projectPath/)
  })

  it('rejects invalid workerCount', () => {
    expect(() => validateSwarmStart('/path', 20)).toThrow(/between 1 and 8/)
  })
})

describe('validateSwarmStop', () => {
  it('validates projectPath', () => {
    const result = validateSwarmStop('/path/to/project')
    expect(result).toEqual({ projectPath: '/path/to/project' })
  })

  it('rejects invalid projectPath', () => {
    expect(() => validateSwarmStop('')).toThrow(/projectPath/)
  })
})

describe('validateSwarmInject', () => {
  it('validates projectPath and request', () => {
    const result = validateSwarmInject('/path', 'Build an API')
    expect(result).toEqual({ projectPath: '/path', request: 'Build an API' })
  })

  it('rejects empty request', () => {
    expect(() => validateSwarmInject('/path', '')).toThrow(/non-empty/)
  })

  it('rejects invalid projectPath', () => {
    expect(() => validateSwarmInject('', 'plan')).toThrow(/projectPath/)
  })
})

describe('validateSwarmQueueRemove', () => {
  it('validates projectPath and id', () => {
    const result = validateSwarmQueueRemove('/path', 'plan-123')
    expect(result).toEqual({ projectPath: '/path', id: 'plan-123' })
  })

  it('rejects invalid id', () => {
    expect(() => validateSwarmQueueRemove('/path', '')).toThrow(/non-empty/)
  })
})

describe('validateSwarmActivity', () => {
  it('validates projectPath and limit', () => {
    const result = validateSwarmActivity('/path', 100)
    expect(result).toEqual({ projectPath: '/path', limit: 100 })
  })

  it('uses default limit', () => {
    const result = validateSwarmActivity('/path', undefined)
    expect(result.limit).toBe(50)
  })
})

describe('validateSwarmAgentOutput', () => {
  it('validates projectPath and agentId', () => {
    const result = validateSwarmAgentOutput('/path', 'worker-0')
    expect(result).toEqual({ projectPath: '/path', agentId: 'worker-0' })
  })

  it('rejects path traversal in agentId', () => {
    expect(() => validateSwarmAgentOutput('/path', '../etc')).toThrow(/worker-/)
  })
})

describe('validateSwarmAgentLogContent', () => {
  it('validates projectPath and filename', () => {
    const result = validateSwarmAgentLogContent('/path', 'worker-0_think_2024-01-01.log')
    expect(result).toEqual({ projectPath: '/path', filename: 'worker-0_think_2024-01-01.log' })
  })

  it('rejects path traversal in filename', () => {
    expect(() => validateSwarmAgentLogContent('/path', '../secrets')).toThrow(/path separators/)
  })
})

describe('validateSwarmQueue', () => {
  it('validates projectPath', () => {
    const result = validateSwarmQueue('/path/to/project')
    expect(result).toEqual({ projectPath: '/path/to/project' })
  })

  it('rejects invalid projectPath', () => {
    expect(() => validateSwarmQueue('')).toThrow(/projectPath/)
    expect(() => validateSwarmQueue(null)).toThrow(/projectPath/)
  })
})

describe('validateSwarmStatus', () => {
  it('validates projectPath', () => {
    const result = validateSwarmStatus('/path/to/project')
    expect(result).toEqual({ projectPath: '/path/to/project' })
  })

  it('rejects invalid projectPath', () => {
    expect(() => validateSwarmStatus('')).toThrow(/projectPath/)
  })
})

describe('validateSwarmBeads', () => {
  it('validates projectPath and status', () => {
    const result = validateSwarmBeads('/path', 'open')
    expect(result).toEqual({ projectPath: '/path', status: 'open' })
  })

  it('defaults status to all', () => {
    const result = validateSwarmBeads('/path', undefined)
    expect(result.status).toBe('all')
  })

  it('accepts all valid statuses', () => {
    expect(validateSwarmBeads('/path', 'closed').status).toBe('closed')
    expect(validateSwarmBeads('/path', 'in_progress').status).toBe('in_progress')
    expect(validateSwarmBeads('/path', 'all').status).toBe('all')
  })

  it('rejects invalid status', () => {
    expect(() => validateSwarmBeads('/path', 'invalid')).toThrow(/Invalid filter/)
  })

  it('rejects invalid projectPath', () => {
    expect(() => validateSwarmBeads('', 'open')).toThrow(/projectPath/)
  })
})

describe('validateSwarmBeadStats', () => {
  it('validates projectPath', () => {
    const result = validateSwarmBeadStats('/path/to/project')
    expect(result).toEqual({ projectPath: '/path/to/project' })
  })

  it('rejects invalid projectPath', () => {
    expect(() => validateSwarmBeadStats('')).toThrow(/projectPath/)
  })
})

describe('validateSwarmAgentLogs', () => {
  it('validates projectPath', () => {
    const result = validateSwarmAgentLogs('/path/to/project')
    expect(result).toEqual({ projectPath: '/path/to/project' })
  })

  it('rejects invalid projectPath', () => {
    expect(() => validateSwarmAgentLogs('')).toThrow(/projectPath/)
    expect(() => validateSwarmAgentLogs(null)).toThrow(/projectPath/)
  })
})

describe('validateSwarmPauseResume', () => {
  it('validates projectPath and agentId', () => {
    const result = validateSwarmPauseResume('/path', 'worker-0')
    expect(result).toEqual({ projectPath: '/path', agentId: 'worker-0' })
  })

  it('rejects invalid projectPath', () => {
    expect(() => validateSwarmPauseResume('', 'worker-0')).toThrow(/projectPath/)
  })

  it('rejects invalid agentId', () => {
    expect(() => validateSwarmPauseResume('/path', 'bad-id')).toThrow(/worker-/)
  })

  it('rejects path traversal in agentId', () => {
    expect(() => validateSwarmPauseResume('/path', '../etc')).toThrow(/worker-/)
  })
})

// ── validateSwarmKnowledge ────────────────────────────────────────────────────

describe('validateSwarmKnowledge', () => {
  it('validates projectPath and limit', () => {
    const result = validateSwarmKnowledge('/path', 100)
    expect(result).toEqual({ projectPath: '/path', limit: 100 })
  })

  it('uses default limit when undefined', () => {
    const result = validateSwarmKnowledge('/path', undefined)
    expect(result.limit).toBe(50)
  })

  it('rejects invalid projectPath', () => {
    expect(() => validateSwarmKnowledge('', 50)).toThrow(/projectPath/)
    expect(() => validateSwarmKnowledge(null, 50)).toThrow(/projectPath/)
  })

  it('rejects invalid limit', () => {
    expect(() => validateSwarmKnowledge('/path', 0)).toThrow(/between 1 and 1000/)
    expect(() => validateSwarmKnowledge('/path', 1001)).toThrow(/between 1 and 1000/)
    expect(() => validateSwarmKnowledge('/path', 1.5)).toThrow(/integer/)
  })
})

// ── validateBuildMonitorEnabled ───────────────────────────────────────────

describe('validateBuildMonitorEnabled', () => {
  it('accepts true', () => {
    expect(validateBuildMonitorEnabled(true)).toBe(true)
  })

  it('accepts false', () => {
    expect(validateBuildMonitorEnabled(false)).toBe(false)
  })

  it('rejects string "true"', () => {
    expect(() => validateBuildMonitorEnabled('true')).toThrow(/boolean/)
  })

  it('rejects string "false"', () => {
    expect(() => validateBuildMonitorEnabled('false')).toThrow(/boolean/)
  })

  it('rejects number 1', () => {
    expect(() => validateBuildMonitorEnabled(1)).toThrow(/boolean/)
  })

  it('rejects number 0', () => {
    expect(() => validateBuildMonitorEnabled(0)).toThrow(/boolean/)
  })

  it('rejects null', () => {
    expect(() => validateBuildMonitorEnabled(null)).toThrow(/boolean/)
  })

  it('rejects undefined', () => {
    expect(() => validateBuildMonitorEnabled(undefined)).toThrow(/boolean/)
  })
})

// ── validateSwarmBuildMonitorToggle ──────────────────────────────────────

describe('validateSwarmBuildMonitorToggle', () => {
  it('validates projectPath and enabled=true', () => {
    const result = validateSwarmBuildMonitorToggle('/path/to/project', true)
    expect(result).toEqual({ projectPath: '/path/to/project', enabled: true })
  })

  it('validates projectPath and enabled=false', () => {
    const result = validateSwarmBuildMonitorToggle('/path/to/project', false)
    expect(result).toEqual({ projectPath: '/path/to/project', enabled: false })
  })

  it('rejects invalid projectPath', () => {
    expect(() => validateSwarmBuildMonitorToggle('', true)).toThrow(/projectPath/)
    expect(() => validateSwarmBuildMonitorToggle(null, true)).toThrow(/projectPath/)
  })

  it('rejects non-boolean enabled', () => {
    expect(() => validateSwarmBuildMonitorToggle('/path', 'true')).toThrow(/boolean/)
    expect(() => validateSwarmBuildMonitorToggle('/path', 1)).toThrow(/boolean/)
    expect(() => validateSwarmBuildMonitorToggle('/path', null)).toThrow(/boolean/)
    expect(() => validateSwarmBuildMonitorToggle('/path', undefined)).toThrow(/boolean/)
  })
})

// ── validateSwarmActivityForBead ─────────────────────────────────────────

describe('validateSwarmActivityForBead', () => {
  it('validates projectPath, beadId, and limit', () => {
    const result = validateSwarmActivityForBead('/path', 'abc-123', 100)
    expect(result).toEqual({ projectPath: '/path', beadId: 'abc-123', limit: 100 })
  })

  it('uses default limit when undefined', () => {
    const result = validateSwarmActivityForBead('/path', 'abc-123', undefined)
    expect(result.limit).toBe(50)
  })

  it('rejects invalid projectPath', () => {
    expect(() => validateSwarmActivityForBead('', 'abc-123', 50)).toThrow(/projectPath/)
  })

  it('rejects invalid beadId', () => {
    expect(() => validateSwarmActivityForBead('/path', '', 50)).toThrow(/non-empty/)
    expect(() => validateSwarmActivityForBead('/path', null, 50)).toThrow(/non-empty/)
  })

  it('rejects invalid limit', () => {
    expect(() => validateSwarmActivityForBead('/path', 'abc-123', 0)).toThrow(/between 1 and 1000/)
    expect(() => validateSwarmActivityForBead('/path', 'abc-123', 1001)).toThrow(/between 1 and 1000/)
  })
})

// ── validateSwarmActivityForAgent ────────────────────────────────────────

describe('validateSwarmActivityForAgent', () => {
  it('validates projectPath, agentId, and limit', () => {
    const result = validateSwarmActivityForAgent('/path', 'worker-0', 100)
    expect(result).toEqual({ projectPath: '/path', agentId: 'worker-0', limit: 100 })
  })

  it('uses default limit when undefined', () => {
    const result = validateSwarmActivityForAgent('/path', 'worker-0', undefined)
    expect(result.limit).toBe(50)
  })

  it('rejects invalid projectPath', () => {
    expect(() => validateSwarmActivityForAgent('', 'worker-0', 50)).toThrow(/projectPath/)
  })

  it('rejects invalid agentId', () => {
    expect(() => validateSwarmActivityForAgent('/path', 'bad-id', 50)).toThrow(/worker-/)
    expect(() => validateSwarmActivityForAgent('/path', '', 50)).toThrow(/non-empty/)
  })

  it('rejects invalid limit', () => {
    expect(() => validateSwarmActivityForAgent('/path', 'worker-0', 0)).toThrow(/between 1 and 1000/)
    expect(() => validateSwarmActivityForAgent('/path', 'worker-0', 1001)).toThrow(/between 1 and 1000/)
  })
})

// ── validateSwarmBuildMonitorStatus ──────────────────────────────────────

describe('validateSwarmBuildMonitorStatus', () => {
  it('validates projectPath', () => {
    const result = validateSwarmBuildMonitorStatus('/path/to/project')
    expect(result).toEqual({ projectPath: '/path/to/project' })
  })

  it('rejects invalid projectPath', () => {
    expect(() => validateSwarmBuildMonitorStatus('')).toThrow(/projectPath/)
    expect(() => validateSwarmBuildMonitorStatus(null)).toThrow(/projectPath/)
  })
})
