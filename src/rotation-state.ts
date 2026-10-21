import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { SecretRotationConfig, RotationStalenessWarning } from './types.js'

const CONFIG_DIR = '.environment-manager'
const STATE_FILE = 'rotation-state.json'

/** State is per environment: rotating preview must not restart production's clock. */
export function rotationKey(env: string, name: string): string {
  return `${env}/${name}`
}

export interface RotationState {
  /** Maps rotationKey(env, name) to the ISO 8601 timestamp of the last rotation */
  lastRotated: Record<string, string>
}

export function loadRotationState(repoRoot: string): RotationState {
  const path = resolve(repoRoot, CONFIG_DIR, STATE_FILE)
  try {
    const raw = readFileSync(path, 'utf-8')
    return JSON.parse(raw)
  } catch {
    return { lastRotated: {} }
  }
}

export function saveRotationState(repoRoot: string, state: RotationState): void {
  const path = resolve(repoRoot, CONFIG_DIR, STATE_FILE)
  writeFileSync(path, JSON.stringify(state, null, 2) + '\n', 'utf-8')
}

export function recordRotation(repoRoot: string, secretName: string): void {
  const state = loadRotationState(repoRoot)
  state.lastRotated[secretName] = new Date().toISOString()
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
