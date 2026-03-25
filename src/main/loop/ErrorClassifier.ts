export type ErrorCategory = 'permanent' | 'transient' | 'unknown'

const PERMANENT_PATTERNS: RegExp[] = [
  /invalid api key/i,
  /authentication failed/i,
  /unauthorized/i,
  /account disabled/i,
  /model not found/i
]

const TRANSIENT_PATTERNS: RegExp[] = [
  /ECONNRESET/,
  /ETIMEDOUT/,
  /ENOTFOUND/,
  /ECONNREFUSED/,
  /socket hang up/i,
  /network error/i,
  /fetch failed/i
]

export function classifyError(errorLine: string): ErrorCategory {
  for (const pattern of PERMANENT_PATTERNS) {
    if (pattern.test(errorLine)) return 'permanent'
  }
  for (const pattern of TRANSIENT_PATTERNS) {
    if (pattern.test(errorLine)) return 'transient'
  }
  return 'unknown'
}
