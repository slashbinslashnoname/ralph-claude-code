import * as fs from 'fs'
import * as child_process from 'child_process'

export function buildEnv(): NodeJS.ProcessEnv {
  const extraPaths = [
    '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin',
    '/opt/homebrew/bin', '/opt/homebrew/sbin',
    `${process.env.HOME ?? ''}/.local/bin`,
    `${process.env.HOME ?? ''}/.npm-global/bin`,
    `${process.env.HOME ?? ''}/.volta/bin`,
    `${process.env.HOME ?? ''}/.cargo/bin`,
  ]
  let loginPath = ''
  try {
    loginPath = child_process.execSync('bash -l -c "echo $PATH"', { timeout: 3000 }).toString().trim()
  } catch { /* ignore */ }
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
