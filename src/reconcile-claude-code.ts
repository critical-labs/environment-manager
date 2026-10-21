import { readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { resolve } from 'node:path'
import type { SecretRotationConfig, ClaudeCodeMapping } from './types.js'

export interface ClaudeCodeReconcileResult {
  mcpServer: string
  target: string
  status: 'ok' | 'updated' | 'error'
  error?: string
}

type SecretReader = (itemId: string, field: string) => Promise<string>

const CLAUDE_JSON_PATH = resolve(homedir(), '.claude.json')

interface McpServerEntry {
  env?: Record<string, string>
  headers?: Record<string, string>
  [key: string]: unknown
}

interface ClaudeJson {
  mcpServers?: Record<string, McpServerEntry>
  projects?: Record<string, { mcpServers?: Record<string, McpServerEntry>; [key: string]: unknown }>
  [key: string]: unknown
}

function readClaudeJson(): ClaudeJson {
  const raw = readFileSync(CLAUDE_JSON_PATH, 'utf-8')
  return JSON.parse(raw)
}

function writeClaudeJson(data: ClaudeJson): void {
  writeFileSync(CLAUDE_JSON_PATH, JSON.stringify(data, null, 2) + '\n', 'utf-8')
}

function findMcpServer(claudeJson: ClaudeJson, serverName: string): McpServerEntry | undefined {
  // Check top-level mcpServers first
  if (claudeJson.mcpServers?.[serverName]) return claudeJson.mcpServers[serverName]
  // Check all project-level mcpServers
  if (claudeJson.projects) {
    for (const project of Object.values(claudeJson.projects)) {
      if (project.mcpServers?.[serverName]) return project.mcpServers[serverName]
    }
  }
  return undefined
}

function applyMapping(
  claudeJson: ClaudeJson,
  mapping: ClaudeCodeMapping,
  value: string,
): { changed: boolean; target: string } {
  const server = findMcpServer(claudeJson, mapping.mcpServer)
  if (!server) {
    throw new Error(`MCP server "${mapping.mcpServer}" not found in ~/.claude.json`)
  }

  if (mapping.envVar) {
    if (!server.env) server.env = {}
    const current = server.env[mapping.envVar]
    if (current === value) return { changed: false, target: `env.${mapping.envVar}` }
    server.env[mapping.envVar] = value
    return { changed: true, target: `env.${mapping.envVar}` }
  }

  if (mapping.header) {
    if (!server.headers) server.headers = {}
    const prefix = mapping.headerPrefix ?? ''
    const fullValue = prefix + value
    const current = server.headers[mapping.header]
    if (current === fullValue) return { changed: false, target: `headers.${mapping.header}` }
    server.headers[mapping.header] = fullValue
    return { changed: true, target: `headers.${mapping.header}` }
  }

  throw new Error(`ClaudeCode mapping for "${mapping.mcpServer}" must specify envVar or header`)
}

export async function reconcileClaudeCode(
  secrets: SecretRotationConfig[],
  env: string,
  readSecret: SecretReader,
): Promise<ClaudeCodeReconcileResult[]> {
  const results: ClaudeCodeReconcileResult[] = []

  // Collect all mappings that need updating
  const updates: { mapping: ClaudeCodeMapping; value: string }[] = []

  for (const secret of secrets) {
    if (!secret.environments.includes(env)) continue
    if (!secret.onePassword) continue
    if (!secret.claudeCode || secret.claudeCode.length === 0) continue

    let opValue: string
    try {
      opValue = await readSecret(secret.onePassword.itemId, secret.onePassword.field)
    } catch (err) {
      for (const mapping of secret.claudeCode) {
        results.push({
          mcpServer: mapping.mcpServer,
          target: mapping.envVar ?? mapping.header ?? 'unknown',
          status: 'error',
          error: `failed to resolve 1Password value: ${err}`,
        })
      }
      continue
    }

    for (const mapping of secret.claudeCode) {
      updates.push({ mapping, value: opValue })
    }
  }

  if (updates.length === 0) return results

  // Read once, apply all changes, write once
  let claudeJson: ClaudeJson
  try {
    claudeJson = readClaudeJson()
  } catch (err) {
    return updates.map(({ mapping }) => ({
      mcpServer: mapping.mcpServer,
      target: mapping.envVar ?? mapping.header ?? 'unknown',
      status: 'error' as const,
      error: `failed to read ~/.claude.json: ${err}`,
    }))
  }

  let anyChanged = false
  for (const { mapping, value } of updates) {
    try {
      const { changed, target } = applyMapping(claudeJson, mapping, value)
      anyChanged = anyChanged || changed
      results.push({
        mcpServer: mapping.mcpServer,
        target,
        status: changed ? 'updated' : 'ok',
      })
    } catch (err) {
      results.push({
        mcpServer: mapping.mcpServer,
        target: mapping.envVar ?? mapping.header ?? 'unknown',
        status: 'error',
        error: String(err),
      })
    }
  }

  if (anyChanged) {
    writeClaudeJson(claudeJson)
  }

  return results
}
