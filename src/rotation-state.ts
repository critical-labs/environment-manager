import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import type { SecretRotationConfig, RotationStalenessWarning } from './types.js'

/** State is per environment: rotating preview must not restart production's clock. */
export function rotationKey(env: string, name: string): string {
  return `${env}/${name}`
}

export interface RotationState {
  /** Maps rotationKey(env, name) to the ISO 8601 timestamp of the last rotation */
  lastRotated: Record<string, string>
}

function dataHome(): string {
  if (process.env.EM_DATA_HOME) return process.env.EM_DATA_HOME
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Application Support', 'environment-manager')
  return join(process.env.XDG_STATE_HOME || join(homedir(), '.local', 'state'), 'environment-manager')
}

/**
 * Per-machine data for one repository, outside it: rotation history and the
 * scheduled job's files. Named for the repository plus a hash of its path, so
 * two clones never share it.
 */
export function dataDir(repoRoot: string): string {
  let real = resolve(repoRoot)
  try {
    real = realpathSync(real)
  } catch {
    // a path that does not exist yet still gets a stable name
  }
  const slug = basename(real).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'repo'
  const hash = createHash('sha256').update(real).digest('hex').slice(0, 8)
  return join(dataHome(), `${slug}-${hash}`)
}

/** EM_STATE_FILE wins: the scheduled job runs from a snapshot, not the repository. */
export function stateFile(repoRoot: string): string {
  return process.env.EM_STATE_FILE || join(dataDir(repoRoot), 'rotation-state.json')
}

function readState(path: string): RotationState | undefined {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8'))
    return { lastRotated: parsed.lastRotated ?? {} }
  } catch {
    return undefined
  }
}

export function loadRotationState(repoRoot: string): RotationState {
  return readState(stateFile(repoRoot))
    // Before 0.3.0 the history lived in the repository.
    ?? (process.env.EM_STATE_FILE ? undefined : readState(join(repoRoot, '.environment-manager', 'rotation-state.json')))
    ?? { lastRotated: {} }
}

export function saveRotationState(repoRoot: string, state: RotationState): void {
  const path = stateFile(repoRoot)
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  writeFileSync(path, JSON.stringify(state, null, 2) + '\n', { encoding: 'utf-8', mode: 0o600 })
}

export function recordRotation(repoRoot: string, key: string): void {
  const state = loadRotationState(repoRoot)
  state.lastRotated[key] = new Date().toISOString()
  saveRotationState(repoRoot, state)
}

export function checkStaleness(
  secrets: SecretRotationConfig[],
  env: string,
  repoRoot: string,
): RotationStalenessWarning[] {
  const state = loadRotationState(repoRoot)
  const warnings: RotationStalenessWarning[] = []
  const now = Date.now()

  for (const secret of secrets) {
    if (!secret.rotationIntervalDays) continue
    if (!secret.environments.includes(env)) continue

    const lastRotated = state.lastRotated[rotationKey(env, secret.name)]
    const daysSince = lastRotated
      ? Math.floor((now - new Date(lastRotated).getTime()) / (1000 * 60 * 60 * 24))
      : Infinity

    if (daysSince >= secret.rotationIntervalDays) {
      warnings.push({
        name: secret.name,
        daysSinceRotation: daysSince === Infinity ? -1 : daysSince,
        rotationIntervalDays: secret.rotationIntervalDays,
      })
    }
  }

  return warnings
}
