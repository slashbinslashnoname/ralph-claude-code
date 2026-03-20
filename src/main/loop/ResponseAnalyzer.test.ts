import { describe, it, expect } from 'vitest'
import {
  extractResultFromJsonStream,
  parseSlashbotStatus,
  detectApiLimit,
  analyze
} from './ResponseAnalyzer'

describe('ResponseAnalyzer', () => {
  describe('extractResultFromJsonStream', () => {
    it('extracts text from a result-type JSON line', () => {
      const raw = '{"type":"result","result":"hello world","sessionId":"s1"}'
      const { text, sessionId, isError } = extractResultFromJsonStream(raw)
      expect(text).toBe('hello world')
      expect(sessionId).toBe('s1')
      expect(isError).toBe(false)
    })

    it('returns empty text when no result line present', () => {
      const raw = 'some random output\nno json here'
      const { text, sessionId, isError } = extractResultFromJsonStream(raw)
      expect(text).toBe('')
      expect(sessionId).toBeUndefined()
      expect(isError).toBe(false)
    })

    it('sets isError when result has is_error flag', () => {
      const raw = '{"type":"result","result":"fail","is_error":true}'
      const { isError } = extractResultFromJsonStream(raw)
      expect(isError).toBe(true)
    })

    it('picks up sessionId from system-type lines', () => {
      const raw = [
        '{"type":"system","sessionId":"sys-123"}',
        '{"type":"result","result":"ok"}'
      ].join('\n')
      const { text, sessionId } = extractResultFromJsonStream(raw)
      expect(text).toBe('ok')
      expect(sessionId).toBe('sys-123')
    })

    it('uses the last result line when multiple exist', () => {
      const raw = [
        '{"type":"result","result":"first"}',
        '{"type":"result","result":"second"}'
      ].join('\n')
      const { text } = extractResultFromJsonStream(raw)
      expect(text).toBe('second')
    })

    it('handles null result gracefully', () => {
      const raw = '{"type":"result","result":null}'
      const { text } = extractResultFromJsonStream(raw)
      expect(text).toBe('')
    })

    it('skips non-JSON lines without errors', () => {
      const raw = [
        'not json',
        '  also not json',
        '{"type":"result","result":"ok"}'
      ].join('\n')
      const { text } = extractResultFromJsonStream(raw)
      expect(text).toBe('ok')
    })

    it('skips lines not starting with {', () => {
      const raw = '  [1,2,3]\n{"type":"result","result":"yes"}'
      const { text } = extractResultFromJsonStream(raw)
      expect(text).toBe('yes')
    })
  })

  describe('parseSlashbotStatus', () => {
    it('extracts RALPH_STATUS JSON from text', () => {
      const text = 'Done!\nRALPH_STATUS: { "STATUS": "COMPLETE", "EXIT_SIGNAL": true, "FILES_MODIFIED": 3 }'
      const status = parseSlashbotStatus(text)
      expect(status).toEqual({ STATUS: 'COMPLETE', EXIT_SIGNAL: true, FILES_MODIFIED: 3 })
    })

    it('returns empty object when no RALPH_STATUS present', () => {
      expect(parseSlashbotStatus('just some text')).toEqual({})
    })

    it('returns empty object on malformed JSON after RALPH_STATUS:', () => {
      expect(parseSlashbotStatus('RALPH_STATUS: {not valid json}')).toEqual({})
    })

    it('handles RALPH_STATUS with extra whitespace', () => {
      const text = 'RALPH_STATUS:   { "EXIT_SIGNAL": false }'
      expect(parseSlashbotStatus(text)).toEqual({ EXIT_SIGNAL: false })
    })
  })

  describe('detectApiLimit', () => {
    it('detects "5-hour limit" in tail of output', () => {
      const lines = Array(25).fill('normal output')
      lines.push('You have reached your 5-hour limit')
      expect(detectApiLimit(lines.join('\n'))).toBe(true)
    })

    it('detects "rate limit reached"', () => {
      expect(detectApiLimit('rate limit reached')).toBe(true)
    })

    it('detects "You\'re out of extra usage"', () => {
      expect(detectApiLimit("You're out of extra usage")).toBe(true)
    })

    it('returns false for normal output', () => {
      expect(detectApiLimit('everything is fine\nno limits here')).toBe(false)
    })

    it('ignores rate limit text in user/tool_result lines', () => {
      const raw = '{"type":"user"} 5-hour limit\ntool_result rate limit reached\ntool_use_id something'
      expect(detectApiLimit(raw)).toBe(false)
    })

    it('only checks last 30 lines', () => {
      const lines = ['rate limit reached', ...Array(35).fill('normal output')]
      expect(detectApiLimit(lines.join('\n'))).toBe(false)
    })
  })

  describe('analyze', () => {
    function makeRaw(result: string): string {
      return `{"type":"result","result":${JSON.stringify(result)}}`
    }

    it('detects completion signal (2+ patterns + EXIT_SIGNAL)', () => {
      const text = 'All tasks are complete. Project complete.\nRALPH_STATUS: { "EXIT_SIGNAL": true, "FILES_MODIFIED": 5 }'
      const r = analyze(makeRaw(text))
      expect(r.hasCompletionSignal).toBe(true)
      expect(r.exitSignal).toBe(true)
      expect(r.filesModified).toBe(5)
    })

    it('no completion signal with EXIT_SIGNAL but only 1 pattern', () => {
      const text = 'All tasks are complete.\nRALPH_STATUS: { "EXIT_SIGNAL": true }'
      const r = analyze(makeRaw(text))
      expect(r.hasCompletionSignal).toBe(false)
      expect(r.exitSignal).toBe(true)
    })

    it('no completion signal with 2 patterns but no EXIT_SIGNAL', () => {
      const text = 'All tasks complete. Project complete.\nRALPH_STATUS: { "EXIT_SIGNAL": false }'
      const r = analyze(makeRaw(text))
      expect(r.hasCompletionSignal).toBe(false)
    })

    it('detects EXIT_SIGNAL as string "true"', () => {
      const text = 'RALPH_STATUS: { "EXIT_SIGNAL": "true" }'
      const r = analyze(makeRaw(text))
      expect(r.exitSignal).toBe(true)
    })

    it('detects asking questions from RALPH_STATUS flag', () => {
      const text = 'RALPH_STATUS: { "ASKING_QUESTIONS": true, "QUESTION_COUNT": 2 }'
      const r = analyze(makeRaw(text))
      expect(r.askingQuestions).toBe(true)
      expect(r.questionCount).toBe(2)
    })

    it('detects asking questions heuristically from question patterns', () => {
      const text = 'Should I proceed with the changes?\nRALPH_STATUS: { "ASKING_QUESTIONS": false }'
      const r = analyze(makeRaw(text))
      expect(r.askingQuestions).toBe(true)
    })

    it('detects question mark at end of line', () => {
      const text = 'Is this the right approach?'
      const r = analyze(makeRaw(text))
      expect(r.askingQuestions).toBe(true)
    })

    it('detects "would you like" pattern', () => {
      const text = 'Would you like me to continue?'
      const r = analyze(makeRaw(text))
      expect(r.askingQuestions).toBe(true)
    })

    it('detects "which approach" pattern', () => {
      const text = 'Which approach do you prefer'
      const r = analyze(makeRaw(text))
      expect(r.askingQuestions).toBe(true)
    })

    it('detects permission denials', () => {
      const raw = `{"type":"result","result":"done"}\n"permission_denials": ["rm -rf /"]`
      const r = analyze(raw)
      expect(r.hasPermissionDenials).toBe(true)
      expect(r.deniedCommands).toEqual(['rm -rf /'])
    })

    it('no permission denials when array is empty', () => {
      const raw = `{"type":"result","result":"done"}\n"permission_denials": []`
      const r = analyze(raw)
      expect(r.hasPermissionDenials).toBe(false)
      expect(r.deniedCommands).toEqual([])
    })

    it('detects isStuck for short tentative output', () => {
      const text = "I'm not sure what to do"
      const r = analyze(makeRaw(text))
      expect(r.isStuck).toBe(true)
    })

    it('not stuck for longer output', () => {
      const text = "I'm working on " + 'x'.repeat(100)
      const r = analyze(makeRaw(text))
      expect(r.isStuck).toBe(false)
    })

    it('detects isTestOnly for test output without code changes', () => {
      const text = 'PASS src/test.ts\n5 tests passed'
      const r = analyze(makeRaw(text))
      expect(r.isTestOnly).toBe(true)
    })

    it('not isTestOnly when code change words present', () => {
      const text = 'PASS src/test.ts\nmodified src/foo.ts'
      const r = analyze(makeRaw(text))
      expect(r.isTestOnly).toBe(false)
    })

    it('hasProgress when filesModified > 0', () => {
      const text = 'RALPH_STATUS: { "FILES_MODIFIED": 1 }'
      const r = analyze(makeRaw(text))
      expect(r.hasProgress).toBe(true)
    })

    it('hasProgress when text is long (>200 chars)', () => {
      const text = 'a'.repeat(201)
      const r = analyze(makeRaw(text))
      expect(r.hasProgress).toBe(true)
    })

    it('no progress for short text with 0 files', () => {
      const text = 'ok'
      const r = analyze(makeRaw(text))
      expect(r.hasProgress).toBe(false)
    })

    it('extracts workType from RALPH_STATUS', () => {
      const text = 'RALPH_STATUS: { "WORK_TYPE": "bugfix" }'
      const r = analyze(makeRaw(text))
      expect(r.workType).toBe('bugfix')
    })

    it('defaults workType to unknown', () => {
      const r = analyze(makeRaw('hello'))
      expect(r.workType).toBe('unknown')
    })

    it('extracts workSummary from RALPH_STATUS', () => {
      const text = 'RALPH_STATUS: { "WORK_SUMMARY": "Fixed the bug" }'
      const r = analyze(makeRaw(text))
      expect(r.workSummary).toBe('Fixed the bug')
    })

    it('falls back to truncated text for workSummary', () => {
      const text = 'Some output text here'
      const r = analyze(makeRaw(text))
      expect(r.workSummary).toBe('Some output text here')
    })
  })
})
