import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const CLI_PATH = resolve(import.meta.dirname, '../dist/cli.js')

const ROTATION_YAML = `
toolEnv:
  NEON_API_KEY: "op://Vault/never-read/credential"
databases: []
secrets:
  - name: session-secret
    type: random
    rotationIntervalDays: 30
    onePassword: { itemId: "item", field: "session_secret" }
    environments: [production]
  - name: manual-key
    type: external
    rotationIntervalDays: 90
    onePassword: { itemId: "item", field: "manual_key" }
    environments: [production]
`

function run(cwd: string, args: string[]): { code: number; out: string } {
  try {
    // An empty PATH: if anything reaches for op or gh, the run fails.
    const out = execFileSync(process.execPath, [CLI_PATH, ...args], {
      cwd, encoding: 'utf-8', env: { PATH: '' }, stdio: ['ignore', 'pipe', 'pipe'],
    })
    return { code: 0, out }
  } catch (err: any) {
    return { code: err.status ?? 1, out: `${err.stdout ?? ''}${err.stderr ?? ''}` }
  }
}

describe('rotate --due and record', () => {
  let repo: string

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'em-due-'))
    mkdirSync(join(repo, '.environment-manager'))
    writeFileSync(join(repo, '.environment-manager', 'rotation.yaml'), ROTATION_YAML)
  })

  afterEach(() => rmSync(repo, { recursive: true, force: true }))

  it('with nothing due, exits 0 without resolving credentials', () => {
    writeFileSync(join(repo, '.environment-manager', 'rotation-state.json'), JSON.stringify({
      lastRotated: { 'production/session-secret': new Date().toISOString() },
    }))
    const { code, out } = run(repo, ['rotate', 'production', '--due', '--apply'])
    expect(code).toBe(0)
    expect(out).toContain('nothing due for rotation in production')
  })

  it('never selects external secrets, but warns that they are stale', () => {
    writeFileSync(join(repo, '.environment-manager', 'rotation-state.json'), JSON.stringify({
      lastRotated: { 'production/session-secret': new Date().toISOString() },
    }))
    const { out } = run(repo, ['rotate', 'production', '--due'])
    expect(out).toContain('manual-key')
    expect(out).not.toMatch(/due in production:.*manual-key/)
  })

  it('record restarts the clock for that environment only', () => {
    const { code, out } = run(repo, ['record', 'production', 'manual-key'])
    expect(code).toBe(0)
    expect(out).toContain('Recorded manual-key')
    const state = JSON.parse(readFileSync(join(repo, '.environment-manager', 'rotation-state.json'), 'utf-8'))
    expect(Object.keys(state.lastRotated)).toEqual(['production/manual-key'])
  })

  it('record refuses a name rotation.yaml does not define', () => {
    const { code, out } = run(repo, ['record', 'production', 'typo'])
    expect(code).toBe(1)
    expect(out).toContain('not a database or secret')
  })
})

describe('rotate without Neon', () => {
  it('does not require NEON_API_KEY when rotation.yaml has no databases or OIDC clients', () => {
    const repo = mkdtempSync(join(tmpdir(), 'em-noneon-'))
    try {
      mkdirSync(join(repo, '.environment-manager'))
      writeFileSync(join(repo, '.environment-manager', 'rotation.yaml'), `
databases: []
secrets:
  - name: session-secret
    type: random
    onePassword: { itemId: "item", field: "session_secret" }
    environments: [production]
`)
      const { code, out } = run(repo, ['rotate', 'production'])
      expect(out).not.toContain('NEON_API_KEY')
      expect(out).toContain('session-secret')
      expect(code).toBe(0)
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })
})
