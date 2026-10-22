import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

const CLI_PATH = resolve(import.meta.dirname, '../dist/cli.js')

function run(cwd: string, args: string[], path = ''): { code: number; out: string } {
  try {
    const out = execFileSync(process.execPath, [CLI_PATH, ...args], {
      cwd, encoding: 'utf-8', env: { PATH: path }, stdio: ['ignore', 'pipe', 'pipe'],
    })
    return { code: 0, out }
  } catch (err: any) {
    return { code: err.status ?? 1, out: `${err.stdout ?? ''}${err.stderr ?? ''}` }
  }
}

function expectNoStackTrace(out: string): void {
  expect(out).not.toMatch(/^\s+at /m)
  expect(out).not.toContain('node:fs')
}

describe('setup mistakes get a one-line error', () => {
  let repo: string

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'em-err-'))
  })

  afterEach(() => rmSync(repo, { recursive: true, force: true }))

  it('names the missing manifest', () => {
    mkdirSync(join(repo, '.environment-manager'))
    const { code, out } = run(repo, ['render', 'staging', '--dry-run'])
    expect(code).toBe(1)
    expect(out).toContain('No .environment-manager/staging.manifest.yaml')
    expectNoStackTrace(out)
  })

  it('names the missing rotation.yaml', () => {
    const { code, out } = run(repo, ['verify', 'production'])
    expect(code).toBe(1)
    expect(out).toContain('No .environment-manager/rotation.yaml')
    expectNoStackTrace(out)
  })

  it('says when the 1Password CLI is not installed', () => {
    mkdirSync(join(repo, '.environment-manager'))
    writeFileSync(join(repo, '.environment-manager', 'x.manifest.yaml'), 'shared:\n  S: "op://Vault/Item/field"\n')
    const { code, out } = run(repo, ['render', 'x', '--dry-run'], dirname(process.execPath))
    expect(code).toBe(1)
    expect(out).toContain('1Password CLI (op) was not found')
    expectNoStackTrace(out)
  })
})
