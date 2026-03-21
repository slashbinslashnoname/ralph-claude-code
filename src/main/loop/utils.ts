import * as fs from 'fs'
import * as child_process from 'child_process'

export function buildEnv(): NodeJS.ProcessEnv {
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
  return { ...process.env, PATH: merged }
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

export function stripAnsi(s: string): string {
  return s
    .replace(/\x1B\[[0-9;]*[A-Za-z]/g, '')
    .replace(/\x1B\][^\x07]*\x07/g, '')
    .replace(/\x1B[()][AB012]/g, '')
    .replace(/\x1B[=>]/g, '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
}
