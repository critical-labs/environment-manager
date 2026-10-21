import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { scheduleLabel, buildLaunchAgentPlist, scheduledCommand, snapshotConfig, configDrift } from './schedule.js'

describe('scheduleLabel', () => {
  it('derives a launchd label from the repo directory and environment', () => {
    expect(scheduleLabel('/Users/me/code/My Repo', 'production'))
      .toBe('com.critical-labs.environment-manager.my-repo.production')
  })
})

describe('scheduledCommand', () => {
  it('runs the installed copy with node, rotating only what is due, and notifies', () => {
    expect(scheduledCommand('/opt/node/bin/node', '/data/runtime/cli.js', 'production')).toEqual([
      '/opt/node/bin/node', '/data/runtime/cli.js', 'rotate', 'production', '--due', '--apply', '--notify',
    ])
  })
})

describe('buildLaunchAgentPlist', () => {
  const plist = buildLaunchAgentPlist({
    label: 'com.critical-labs.environment-manager.repo.production',
    programArguments: ['/opt/node/bin/node', '/data/runtime/cli.js', 'rotate', 'production'],
    workingDirectory: '/data/config & co',
    environment: { PATH: '/opt/node/bin:/usr/bin:/bin', EM_STATE_FILE: '/data/rotation-state.json' },
    logPath: '/Users/me/Library/Logs/environment-manager/repo.production.log',
    hour: 10,
  })

  it('runs at login and once a day at the given hour', () => {
    expect(plist).toContain('<key>RunAtLoad</key>\n  <true/>')
    expect(plist).toMatch(/<key>StartCalendarInterval<\/key>\s*<dict>\s*<key>Hour<\/key>\s*<integer>10<\/integer>\s*<key>Minute<\/key>\s*<integer>0<\/integer>/)
  })

  it('runs from the snapshot directory with the given environment', () => {
    expect(plist).toContain('<key>WorkingDirectory</key>\n  <string>/data/config &amp; co</string>')
    expect(plist).toContain('<key>PATH</key>\n    <string>/opt/node/bin:/usr/bin:/bin</string>')
    expect(plist).toContain('<key>EM_STATE_FILE</key>\n    <string>/data/rotation-state.json</string>')
  })

  it('lists every program argument and logs both streams to one file', () => {
    for (const arg of ['/opt/node/bin/node', '/data/runtime/cli.js', 'rotate', 'production']) {
      expect(plist).toContain(`<string>${arg}</string>`)
    }
    expect(plist.match(/repo\.production\.log/g)).toHaveLength(2)
  })

  it('is a well-formed property list', () => {
    expect(plist.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true)
    expect(plist.trimEnd().endsWith('</plist>')).toBe(true)
  })
})

describe('config snapshot', () => {
  let repo: string
  let data: string

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'em-repo-'))
    data = mkdtempSync(join(tmpdir(), 'em-data-'))
    mkdirSync(join(repo, '.environment-manager'))
    writeFileSync(join(repo, '.environment-manager', 'rotation.yaml'), 'secrets: []\n')
  })

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true })
    rmSync(data, { recursive: true, force: true })
  })

  it('copies rotation.yaml, and only it, into the snapshot', () => {
    writeFileSync(join(repo, '.environment-manager', 'prod.manifest.yaml'), 'shared: {}\n')
    const dir = snapshotConfig(repo, data)
    expect(readFileSync(join(dir, '.environment-manager', 'rotation.yaml'), 'utf-8')).toBe('secrets: []\n')
    expect(existsSync(join(dir, '.environment-manager', 'prod.manifest.yaml'))).toBe(false)
  })

  it('reports no drift until the repository config changes', () => {
    snapshotConfig(repo, data)
    expect(configDrift(repo, data)).toBe(false)
    writeFileSync(join(repo, '.environment-manager', 'rotation.yaml'), 'secrets: [changed]\n')
    expect(configDrift(repo, data)).toBe(true)
  })
})
