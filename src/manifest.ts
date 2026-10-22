import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { parse as parseYaml } from 'yaml'
import type { Manifest, RotationConfig, ManifestValue } from './types.js'

const CONFIG_DIR = '.environment-manager'

function configPath(repoRoot: string, filename: string): string {
  return resolve(repoRoot, CONFIG_DIR, filename)
}

function readConfig(repoRoot: string, filename: string, hint: string): string {
  try {
    return readFileSync(configPath(repoRoot, filename), 'utf-8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`No ${CONFIG_DIR}/${filename} in ${resolve(repoRoot)}. ${hint}`)
    }
    throw err
  }
}

function resolveManifestValues(raw: Record<string, ManifestValue>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(raw).map(([key, val]) => [
      key,
      typeof val === 'string' ? val : val.value,
    ]),
  )
}

export function loadManifest(repoRoot: string, env: string): Manifest {
  const raw = readConfig(repoRoot, `${env}.manifest.yaml`, 'Run from the repository root, and check the manifest name.')
  const parsed = parseYaml(raw) ?? {}
  const rawShared = (parsed.shared ?? {}) as Record<string, ManifestValue>
  const rawProjects = (parsed.projects ?? {}) as Record<string, Record<string, ManifestValue>>
  return {
    shared: resolveManifestValues(rawShared),
    projects: Object.fromEntries(
      Object.entries(rawProjects).map(([name, vars]) => [
        name,
        resolveManifestValues(vars),
      ]),
    ),
    ignore: (parsed.ignore as string[] | undefined) ?? [],
  }
}

export function loadRotationConfig(repoRoot: string): RotationConfig {
  const raw = readConfig(repoRoot, 'rotation.yaml', 'Run from the repository root; sync, verify, rotate, record and schedule need it.')
  const parsed = parseYaml(raw) ?? {}
  // The op helpers read the vault from OP_VAULT at call time; an explicit
  // OP_VAULT in the environment wins over the config file.
  if (parsed.vault && !process.env.OP_VAULT) {
    process.env.OP_VAULT = parsed.vault
  }
  return {
    vault: parsed.vault,
    toolEnv: parsed.toolEnv,
    databases: parsed.databases ?? [],
    secrets: parsed.secrets ?? [],
  }
}
