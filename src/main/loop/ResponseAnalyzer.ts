import { AnalysisResult } from './types'

// Patterns that suggest Claude is asking questions instead of acting
const QUESTION_PATTERNS = [
  /\?\s*$\n?/m,
  /(?:should I|shall I|do you want|would you like|can you clarify|please confirm|could you)/i,
  /(?:which (?:approach|option|method)|what (?:should|do) you)/i
]

// Patterns that indicate genuine completion
const COMPLETION_PATTERNS = [
  /EXIT_SIGNAL:\s*true/i,
  /all (?:tasks?|items?|features?) (?:are )?(?:complete|done|finished)/i,
  /(?:project|implementation|milestone) (?:is )?complete/i,
  /nothing (?:more|else) (?:to do|remains)/i
]

interface ClaudeJsonResult {
  type?: string
  result?: string
  sessionId?: string
  is_error?: boolean
  subtype?: string
}

/** Extract the text result from claude --output-format json stream */
export function extractResultFromJsonStream(raw: string): { text: string; sessionId?: string; isError: boolean } {
  let text = ''
  let sessionId: string | undefined
  let isError = false

  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('{')) continue
    try {
      const obj = JSON.parse(trimmed) as ClaudeJsonResult
      if (obj.type === 'result') {
        text = obj.result ?? ''
        if (obj.sessionId) sessionId = obj.sessionId
        if (obj.is_error) isError = true
      }
      if (obj.type === 'system' && obj.sessionId) sessionId = obj.sessionId
    } catch { /* non-JSON line, skip */ }
  }

  return { text, sessionId, isError }
}

/** Parse the RALPH_STATUS block embedded in Claude's response */
function parseRalphStatus(text: string): Record<string, unknown> {
  // Matches: RALPH_STATUS: { ... } or RALPH_STATUS:\n{ ... }
  const match = text.match(/RALPH_STATUS:\s*(\{[\s\S]*?\})/m)
  if (!match) return {}
  try { return JSON.parse(match[1]) as Record<string, unknown> }
  catch { return {} }
}

/** Detect API rate-limit messages */
export function detectApiLimit(raw: string): boolean {
  const tail = raw.split('\n').slice(-30).join('\n')
  // Filter out echoed tool results before checking
  const filtered = tail
    .split('\n')
    .filter(l => !l.includes('"type":"user"') && !l.includes('tool_result') && !l.includes('tool_use_id'))
    .join('\n')
  return /(?:5-hour limit|rate limit reached|You're out of extra usage)/i.test(filtered)
}

/** Full analysis of a completed Claude invocation */
export function analyze(raw: string): AnalysisResult {
  const { text } = extractResultFromJsonStream(raw)
  const ralphStatus = parseRalphStatus(text)

  // EXIT_SIGNAL from RALPH_STATUS block
  const exitSignal = ralphStatus['EXIT_SIGNAL'] === true || ralphStatus['EXIT_SIGNAL'] === 'true'
  const filesModified = typeof ralphStatus['FILES_MODIFIED'] === 'number' ? ralphStatus['FILES_MODIFIED'] as number : 0
  const askingQuestions = ralphStatus['ASKING_QUESTIONS'] === true
  const questionCount = typeof ralphStatus['QUESTION_COUNT'] === 'number' ? ralphStatus['QUESTION_COUNT'] as number : 0
  const workType = typeof ralphStatus['WORK_TYPE'] === 'string' ? ralphStatus['WORK_TYPE'] as string : 'unknown'

  // Heuristic completion detection (requires exitSignal AND patterns)
  let completionCount = 0
  for (const pat of COMPLETION_PATTERNS) if (pat.test(text)) completionCount++
  const hasCompletionSignal = completionCount >= 2 && exitSignal

  // Question detection (RALPH_STATUS overrides heuristics)
  const askingQuestionsHeuristic = !askingQuestions && QUESTION_PATTERNS.some(p => p.test(text))

  // Permission denials: check for JSON field in raw output
  const permMatch = raw.match(/"permission_denials":\s*(\[[\s\S]*?\])/m)
  let deniedCommands: string[] = []
  if (permMatch) {
    try { deniedCommands = JSON.parse(permMatch[1]) as string[] } catch { /* ok */ }
  }
  const hasPermissionDenials = deniedCommands.length > 0

  // Detect test-only loop (output is almost entirely test execution)
  const isTestOnly = /^(?:PASS|FAIL|ok|not ok|\d+ tests?|bats|pytest|jest)/im.test(text) &&
    !/(?:modified|created|updated|wrote|fixed|added|implemented)/i.test(text)

  // Has progress = any files modified or meaningful text output
  const hasProgress = filesModified > 0 || text.length > 200

  // Detect stuck: repeated identical short output
  const isStuck = text.length < 50 && /^(?:I'm |I am |Let me|I'll)/i.test(text)

  const workSummary = ralphStatus['WORK_SUMMARY'] as string ||
    text.slice(0, 200).replace(/\n/g, ' ')

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
