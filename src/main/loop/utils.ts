import * as fs from 'fs'
import * as child_process from 'child_process'

let _cachedBuildEnv: NodeJS.ProcessEnv | undefined

export function buildEnv(): NodeJS.ProcessEnv {
  if (_cachedBuildEnv) return _cachedBuildEnv
  const home = process.env.HOME ?? ''
  const extraPaths = [
    '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin',
    '/opt/homebrew/bin', '/opt/homebrew/sbin',
    `${home}/.local/bin`,
    `${home}/.npm-global/bin`,
    `${home}/.volta/bin`,
    `${home}/.cargo/bin`,
    `${home}/.local/share/mise/shims`,
  ]
  let loginPath = ''
  // Try bash first, then zsh (macOS default shell) as fallback
  for (const shell of ['bash', 'zsh']) {
    try {
      const raw = child_process.execSync(`${shell} -l -c "echo \\$PATH"`, { timeout: 3000 }).toString().trim()
      // Take only the last line — login shells may emit motd or other text before PATH
      loginPath = raw.split('\n').pop() ?? ''
      if (loginPath) break
    } catch { /* ignore — shell may not exist */ }
  }
  const merged = [...new Set(
    [process.env.PATH ?? '', loginPath, ...extraPaths].flatMap(p => p.split(':').filter(Boolean))
  )].join(':')
  _cachedBuildEnv = { ...process.env, PATH: merged }
  return _cachedBuildEnv
}

/** Reset the buildEnv cache — for testing only. */
export function _resetBuildEnvCache(): void {
  _cachedBuildEnv = undefined
}

export function resolveCmd(cmd: string, env: NodeJS.ProcessEnv): string {
  if (cmd.startsWith('/')) {
    if (fs.existsSync(cmd)) return cmd
    cmd = cmd.split('/').pop() ?? cmd
  }
  try {
    const result = child_process.execFileSync('which', [cmd], { env, timeout: 3000 }).toString().trim()
    if (result.startsWith('/')) return result
  } catch { /* ignore */ }
  return cmd
}

export function atomicWriteSync(dest: string, content: string): void {
  const tmp = dest + '.tmp.' + process.pid
  try {
    fs.writeFileSync(tmp, content)
    fs.renameSync(tmp, dest)
  } catch (e) {
    try { fs.unlinkSync(tmp) } catch { /* ignore cleanup failure */ }
    throw e
  }
}

/**
 * Rotate a log file if it exceeds maxSize bytes.
 * Keeps up to maxRotations rotated copies (.1, .2, .3, …).
 * Returns true if rotation occurred.
 */
export function rotateLogFile(logFile: string, maxSize: number, maxRotations: number): boolean {
  try {
    const stat = fs.statSync(logFile)
    if (stat.size <= maxSize) return false
  } catch {
    return false
  }
  try {
    // Shift existing rotated files: .2→.3, .1→.2
    for (let i = maxRotations; i >= 2; i--) {
      const src = `${logFile}.${i - 1}`
      const dest = `${logFile}.${i}`
      try {
        if (fs.existsSync(src)) fs.renameSync(src, dest)
      } catch { /* best-effort */ }
    }
    // Rotate current file to .1
    fs.renameSync(logFile, `${logFile}.1`)
    return true
  } catch {
    return false
  }
}

export function stripAnsi(s: string): string {
  return s
    .replace(/\x1B\[[0-9;]*[A-Za-z]/g, '')
    .replace(/\x1B\][^\x07]*\x07/g, '')
    .replace(/\x1B[()][AB012]/g, '')
    .replace(/\x1B[=>]/g, '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
}
