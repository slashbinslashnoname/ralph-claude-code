/**
 * Validation helpers for Telegram IPC handlers.
 * Pure functions — throw on invalid input so the IPC try/catch
 * returns { ok: false, error } to the renderer.
 */

import { validatePath } from './ipcValidation'
import type { TelegramNotifyLevel } from '../types'

const TELEGRAM_BOT_TOKEN_RE = /^\d+:[A-Za-z0-9_-]+$/
const VALID_NOTIFY_LEVELS: readonly TelegramNotifyLevel[] = ['all', 'errors', 'completions', 'none']

export function validateTelegramProjectPath(projectPath: unknown): string {
  return validatePath(projectPath, { field: 'projectPath', absolute: true })
}

export interface ValidatedTelegramConfig {
  projectPath: string
  botToken: string
  chatId: string
  notifyLevel: TelegramNotifyLevel
}

export function validateTelegramConfigure(
  projectPath: unknown,
  opts: unknown
): ValidatedTelegramConfig {
  const pp = validateTelegramProjectPath(projectPath)

  if (!opts || typeof opts !== 'object') {
    throw new Error('configure options must be an object')
  }

  const { botToken, chatId, notifyLevel } = opts as Record<string, unknown>

  if (typeof botToken !== 'string' || botToken.trim().length === 0) {
    throw new Error('botToken is required')
  }
  if (!TELEGRAM_BOT_TOKEN_RE.test(botToken)) {
    throw new Error('botToken format is invalid — expected "digits:alphanumeric"')
  }

  if (typeof chatId !== 'string' || chatId.trim().length === 0) {
    throw new Error('chatId is required')
  }
  // chatId can be negative (group chats) or positive (user chats)
  if (!/^-?\d+$/.test(chatId.trim())) {
    throw new Error('chatId must be a numeric string')
  }

  let level: TelegramNotifyLevel = 'errors'
  if (notifyLevel !== undefined) {
    if (typeof notifyLevel !== 'string' || !VALID_NOTIFY_LEVELS.includes(notifyLevel as TelegramNotifyLevel)) {
      throw new Error(`notifyLevel must be one of: ${VALID_NOTIFY_LEVELS.join(', ')}`)
    }
    level = notifyLevel as TelegramNotifyLevel
  }

  return { projectPath: pp, botToken: botToken.trim(), chatId: chatId.trim(), notifyLevel: level }
}
