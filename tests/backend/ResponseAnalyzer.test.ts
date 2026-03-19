import { describe, it, expect } from 'vitest'
import {
  extractResultFromJsonStream,
  detectApiLimit,
  analyze
} from '../../src/main/loop/ResponseAnalyzer'

describe('extractResultFromJsonStream', () => {
  it('extracts text from result message', () => {
    const raw = [
      '{"type":"system","sessionId":"sess-123"}',
      '{"type":"assistant","content":"working..."}',
      '{"type":"result","result":"All tasks complete.","sessionId":"sess-123"}'
    ].join('\n')

    const { text, sessionId, isError } = extractResultFromJsonStream(raw)
    expect(text).toBe('All tasks complete.')
    expect(sessionId).toBe('sess-123')
    expect(isError).toBe(false)
  })

  it('extracts sessionId from system message as fallback', () => {
    const raw = '{"type":"system","sessionId":"sess-456"}\nsome text\n'
    const { sessionId } = extractResultFromJsonStream(raw)
    expect(sessionId).toBe('sess-456')
  })

  it('detects is_error in result', () => {
    const raw = '{"type":"result","result":"Error occurred","is_error":true,"sessionId":"sess-789"}'
    const { isError, text } = extractResultFromJsonStream(raw)
    expect(isError).toBe(true)
    expect(text).toBe('Error occurred')
  })

  it('handles empty input', () => {
    const { text, sessionId, isError } = extractResultFromJsonStream('')
    expect(text).toBe('')
    expect(sessionId).toBeUndefined()
    expect(isError).toBe(false)
  })

  it('ignores non-JSON lines', () => {
    const raw = 'plain text\n{"type":"result","result":"ok"}\nmore text'
    const { text } = extractResultFromJsonStream(raw)
    expect(text).toBe('ok')
  })

  it('handles malformed JSON gracefully', () => {
    const raw = '{broken json\n{"type":"result","result":"ok"}'
    const { text } = extractResultFromJsonStream(raw)
    expect(text).toBe('ok')
  })
})

describe('detectApiLimit', () => {
  it('detects 5-hour limit message', () => {
    const raw = 'some output\n'.repeat(40) + 'You have hit your 5-hour limit.\n'
    expect(detectApiLimit(raw)).toBe(true)
  })

  it('detects rate limit reached', () => {
    const raw = 'output\nrate limit reached\n'
    expect(detectApiLimit(raw)).toBe(true)
  })

  it('detects extra usage exhaustion', () => {
    const raw = "output\nYou're out of extra usage · resets 9pm\n"
    expect(detectApiLimit(raw)).toBe(true)
  })

  it('ignores API limit in echoed tool results', () => {
    const lines = Array(35).fill('normal output')
    lines[30] = '{"type":"user","content":"The 5-hour limit docs say..."}'
    expect(detectApiLimit(lines.join('\n'))).toBe(false)
  })

  it('ignores API limit in tool_result lines', () => {
    const lines = Array(35).fill('normal output')
    lines[30] = '{"tool_result":"rate limit reached in the docs"}'
    expect(detectApiLimit(lines.join('\n'))).toBe(false)
  })

  it('returns false for normal output', () => {
    expect(detectApiLimit('All tasks done. Project complete.')).toBe(false)
  })
})

describe('analyze', () => {
  const makeStream = (resultText: string): string => {
    return `{"type":"result","result":${JSON.stringify(resultText)}}`
  }

  it('detects EXIT_SIGNAL from RALPH_STATUS block', () => {
    const text = `I did some work.\n\nRALPH_STATUS: {"STATUS": "COMPLETE", "EXIT_SIGNAL": true, "WORK_TYPE": "feature", "FILES_MODIFIED": 5}`
    const result = analyze(makeStream(text))
    expect(result.exitSignal).toBe(true)
    expect(result.filesModified).toBe(5)
    expect(result.workType).toBe('feature')
  })

  it('detects completion signal when EXIT_SIGNAL + completion patterns', () => {
    const text = `All tasks are complete. Project complete. Nothing more to do.\n\nRALPH_STATUS: {"STATUS": "COMPLETE", "EXIT_SIGNAL": true, "WORK_TYPE": "feature", "FILES_MODIFIED": 3}`
    const result = analyze(makeStream(text))
    expect(result.hasCompletionSignal).toBe(true)
    expect(result.exitSignal).toBe(true)
  })

  it('does not flag completion when EXIT_SIGNAL is false', () => {
    const text = `All tasks are complete. Project complete.\n\nRALPH_STATUS: {"STATUS": "IN_PROGRESS", "EXIT_SIGNAL": false, "WORK_TYPE": "feature", "FILES_MODIFIED": 2}`
    const result = analyze(makeStream(text))
    expect(result.hasCompletionSignal).toBe(false)
  })

  it('detects asking questions from RALPH_STATUS', () => {
    const text = `RALPH_STATUS: {"STATUS": "IN_PROGRESS", "EXIT_SIGNAL": false, "ASKING_QUESTIONS": true, "QUESTION_COUNT": 2, "FILES_MODIFIED": 0}`
    const result = analyze(makeStream(text))
    expect(result.askingQuestions).toBe(true)
    expect(result.questionCount).toBe(2)
  })

  it('detects questions heuristically', () => {
    const text = 'Should I refactor this function?'
    const result = analyze(makeStream(text))
    expect(result.askingQuestions).toBe(true)
  })

  it('detects permission denials', () => {
    const raw = '{"type":"assistant","content":"working"}\n"permission_denials": ["npm install", "pip install"]'
    const result = analyze(raw)
    expect(result.hasPermissionDenials).toBe(true)
    expect(result.deniedCommands).toEqual(['npm install', 'pip install'])
  })

  it('detects test-only loops', () => {
    const text = 'PASS src/test.ts\n12 tests passed'
    const result = analyze(makeStream(text))
    expect(result.isTestOnly).toBe(true)
  })

  it('does not flag test-only when implementation words present', () => {
    const text = 'PASS src/test.ts\n12 tests passed\nI also modified the main component'
    const result = analyze(makeStream(text))
    expect(result.isTestOnly).toBe(false)
  })

  it('detects stuck output', () => {
    const text = "I'm thinking..."
    const result = analyze(makeStream(text))
    expect(result.isStuck).toBe(true)
  })

  it('detects progress from files modified', () => {
    const text = `RALPH_STATUS: {"STATUS": "IN_PROGRESS", "EXIT_SIGNAL": false, "FILES_MODIFIED": 3}`
    const result = analyze(makeStream(text))
    expect(result.hasProgress).toBe(true)
  })

  it('detects progress from long output', () => {
    const text = 'A'.repeat(300)
    const result = analyze(makeStream(text))
    expect(result.hasProgress).toBe(true)
  })

  it('extracts work summary from RALPH_STATUS', () => {
    const text = `RALPH_STATUS: {"STATUS": "IN_PROGRESS", "EXIT_SIGNAL": false, "WORK_SUMMARY": "Added login page", "FILES_MODIFIED": 2}`
    const result = analyze(makeStream(text))
    expect(result.workSummary).toBe('Added login page')
  })

  it('falls back to text slice for work summary', () => {
    const text = 'I implemented the feature and it works great.'
    const result = analyze(makeStream(text))
    expect(result.workSummary).toContain('I implemented the feature')
  })

  it('handles empty result text', () => {
    const result = analyze(makeStream(''))
    expect(result.exitSignal).toBe(false)
    expect(result.hasCompletionSignal).toBe(false)
    expect(result.filesModified).toBe(0)
  })

  it('EXIT_SIGNAL string "true" is treated as true', () => {
    const text = `RALPH_STATUS: {"EXIT_SIGNAL": "true"}`
    const result = analyze(makeStream(text))
    expect(result.exitSignal).toBe(true)
  })
})
