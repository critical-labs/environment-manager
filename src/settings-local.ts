import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/**
 * Set env.OP_SERVICE_ACCOUNT_TOKEN in a Claude Code settings file, creating it
 * if missing. The file holds a live token, so it is owner-only either way.
 * Returns false when the file already had this token.
 */
export function writeSettingsToken(path: string, token: string): boolean {
  const settings = existsSync(path) ? JSON.parse(readFileSync(path, 'utf-8')) : {}
  if (settings.env?.OP_SERVICE_ACCOUNT_TOKEN === token) return false
  if (!settings.env) settings.env = {}
  settings.env.OP_SERVICE_ACCOUNT_TOKEN = token
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(settings, null, 2) + '\n', { encoding: 'utf-8', mode: 0o600 })
  chmodSync(path, 0o600)
  return true
}
