import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { dataDir, loadRotationState, recordRotation, stateFile } from './rotation-state.js'

describe('rotation state', () => {
  let home: string
  let repo: string
  const saved = { ...process.env }

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'em-home-'))
    repo = mkdtempSync(join(tmpdir(), 'My Repo '))
    process.env.EM_DATA_HOME = home
    delete process.env.EM_STATE_FILE
  })

  afterEach(() => {
    process.env = { ...saved }
    rmSync(home, { recursive: true, force: true })
    rmSync(repo, { recursive: true, force: true })
  })

  it('keeps state outside the repository, in a directory named for it', () => {
    const dir = dataDir(repo)
    expect(dir.startsWith(home)).toBe(true)
    expect(dir).toMatch(/my-repo-[a-z0-9]+-[0-9a-f]{8}$/)
    expect(stateFile(repo)).toBe(join(dir, 'rotation-state.json'))
  })

  it('gives two repositories with the same name different directories', () => {
    const other = mkdtempSync(join(tmpdir(), 'My Repo '))
    try {
      expect(dataDir(other)).not.toBe(dataDir(repo))
    } finally {
      rmSync(other, { recursive: true, force: true })
    }
  })

  it('records and reads back a rotation', () => {
    recordRotation(repo, 'production/session-secret')
    expect(loadRotationState(repo).lastRotated['production/session-secret']).toMatch(/^\d{4}-/)
    expect(existsSync(join(repo, '.environment-manager'))).toBe(false)
  })

  it('migrates a legacy in-repo state file on first read', () => {
    mkdirSync(join(repo, '.environment-manager'))
    writeFileSync(join(repo, '.environment-manager', 'rotation-state.json'), JSON.stringify({
      lastRotated: { 'production/a': '2026-01-01T00:00:00.000Z' },
    }))
    expect(loadRotationState(repo).lastRotated['production/a']).toBe('2026-01-01T00:00:00.000Z')
    recordRotation(repo, 'production/b')
    const saved = JSON.parse(readFileSync(stateFile(repo), 'utf-8'))
    expect(Object.keys(saved.lastRotated).sort()).toEqual(['production/a', 'production/b'])
  })

  it('uses EM_STATE_FILE when set (the scheduled job)', () => {
    const file = join(home, 'pinned.json')
    process.env.EM_STATE_FILE = file
    recordRotation(repo, 'production/x')
    expect(JSON.parse(readFileSync(file, 'utf-8')).lastRotated['production/x']).toBeDefined()
  })
})
