import { AnalysisResult } from '../types'

const QUESTION_PATTERNS = [
  /\?\s*$\n?/m,
  /(?:should I|shall I|do you want|would you like|can you clarify|please confirm|could you)/i,
  /(?:which (?:approach|option|method)|what (?:should|do) you)/i
]

const COMPLETION_PATTERNS = [
  /EXIT_SIGNAL:\s*true/i,
  /all (?:tasks?|items?|features?) (?:are )?(?:complete|done|finished)/i,
  /(?:project|implementation|milestone) (?:is )?complete/i,
  /nothing (?:more|else) (?:to do|remains)/i
]

export function extractResultFromJsonStream(raw: string): {
  text: string
  sessionId?: string
  isError: boolean
} {
  let text = ''
  let sessionId: string | undefined
  let isError = false

  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('{')) continue
    try {
      const obj = JSON.parse(trimmed)
      if (obj.type === 'result') {
        text = obj.result ?? ''
        if (obj.sessionId) sessionId = obj.sessionId
        if (obj.is_error) isError = true
      }
      if (obj.type === 'system' && obj.sessionId) sessionId = obj.sessionId
    } catch { /* skip non-JSON lines */ }
  }

  return { text, sessionId, isError }
}

export function parseSlashbotStatus(text: string): Record<string, unknown> {
  const match = text.match(/RALPH_STATUS:\s*(\{[\s\S]*?\})/m)
  if (!match) return {}
  try {
    return JSON.parse(match[1])
  } catch {
    return {}
  }
}

export function detectApiLimit(raw: string): boolean {
  const tail = raw.split('\n').slice(-30).join('\n')
  const filtered = tail
    .split('\n')
    .filter(l => !l.includes('"type":"user"') && !l.includes('tool_result') && !l.includes('tool_use_id'))
    .join('\n')
  return /(?:5-hour limit|rate limit reached|You're out of extra usage)/i.test(filtered)
}

export function analyze(raw: string): AnalysisResult {
  const { text } = extractResultFromJsonStream(raw)
  const slashbotStatus = parseSlashbotStatus(text)

  const exitSignal = slashbotStatus['EXIT_SIGNAL'] === true || slashbotStatus['EXIT_SIGNAL'] === 'true'
  const filesModified = typeof slashbotStatus['FILES_MODIFIED'] === 'number' ? slashbotStatus['FILES_MODIFIED'] : 0
  const askingQuestions = slashbotStatus['ASKING_QUESTIONS'] === true
  const questionCount = typeof slashbotStatus['QUESTION_COUNT'] === 'number' ? slashbotStatus['QUESTION_COUNT'] : 0
  const workType = typeof slashbotStatus['WORK_TYPE'] === 'string' ? slashbotStatus['WORK_TYPE'] : 'unknown'

  let completionCount = 0
  for (const pat of COMPLETION_PATTERNS) if (pat.test(text)) completionCount++
  const hasCompletionSignal = completionCount >= 2 && exitSignal

  const askingQuestionsHeuristic = !askingQuestions && QUESTION_PATTERNS.some(p => p.test(text))

  const permMatch = raw.match(/"permission_denials":\s*(\[[\s\S]*?\])/m)
  let deniedCommands: string[] = []
  if (permMatch) {
    try { deniedCommands = JSON.parse(permMatch[1]) } catch { /* ignore */ }
  }
  const hasPermissionDenials = deniedCommands.length > 0

  const isTestOnly =
    /^(?:PASS|FAIL|ok|not ok|\d+ tests?|bats|pytest|jest)/im.test(text) &&
    !/(?:modified|created|updated|wrote|fixed|added|implemented)/i.test(text)

  const hasProgress = filesModified > 0 || text.length > 200
  const isStuck = text.length < 50 && /^(?:I'm |I am |Let me|I'll)/i.test(text)
  const workSummary = (slashbotStatus['WORK_SUMMARY'] as string) || text.slice(0, 200).replace(/\n/g, ' ')

  return {
    hasCompletionSignal,
    exitSignal,
    workType,
    filesModified,
    askingQuestions: askingQuestions || askingQuestionsHeuristic,
    questionCount,
    hasPermissionDenials,
    deniedCommands,
    isStuck,
    isTestOnly,
    hasProgress,
    workSummary
  }
}
