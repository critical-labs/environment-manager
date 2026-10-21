import { describe, it, expect } from 'vitest'
import { scheduleLabel, buildLaunchAgentPlist, scheduledCommand } from './schedule.js'

describe('scheduleLabel', () => {
  it('derives a launchd label from the repo directory and environment', () => {
    expect(scheduleLabel('/Users/me/code/My Repo', 'production'))
      .toBe('com.critical-labs.environment-manager.my-repo.production')
  })
})

describe('scheduledCommand', () => {
  it('runs the pinned release, rotating only what is due, and notifies', () => {
    expect(scheduledCommand('/opt/node/bin/npx', '0.2.0', 'production')).toEqual([
      '/opt/node/bin/npx', '--yes', '@critical-labs/environment-manager@0.2.0',
      'rotate', 'production', '--due', '--apply', '--notify',
    ])
  })
})

describe('buildLaunchAgentPlist', () => {
  const plist = buildLaunchAgentPlist({
    label: 'com.critical-labs.environment-manager.repo.production',
    programArguments: ['/opt/node/bin/npx', '--yes', 'pkg@1.0.0', 'rotate', 'production'],
    workingDirectory: '/Users/me/code/repo & co',
    path: '/opt/node/bin:/opt/homebrew/bin:/usr/bin:/bin',
    logPath: '/Users/me/Library/Logs/environment-manager/repo.production.log',
    hour: 10,
  })

  it('runs at login and once a day at the given hour', () => {
    expect(plist).toContain('<key>RunAtLoad</key>\n  <true/>')
    expect(plist).toMatch(/<key>StartCalendarInterval<\/key>\s*<dict>\s*<key>Hour<\/key>\s*<integer>10<\/integer>\s*<key>Minute<\/key>\s*<integer>0<\/integer>/)
  })

  it('runs from the repo root with a PATH that finds node, op, and gh', () => {
    expect(plist).toContain('<key>WorkingDirectory</key>\n  <string>/Users/me/code/repo &amp; co</string>')
    expect(plist).toContain('<key>PATH</key>\n    <string>/opt/node/bin:/opt/homebrew/bin:/usr/bin:/bin</string>')
  })

  it('lists every program argument and logs both streams to one file', () => {
    for (const arg of ['/opt/node/bin/npx', '--yes', 'pkg@1.0.0', 'rotate', 'production']) {
      expect(plist).toContain(`<string>${arg}</string>`)
    }
    expect(plist.match(/repo\.production\.log/g)).toHaveLength(2)
  })

  it('is a well-formed property list', () => {
    expect(plist.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true)
    expect(plist.trimEnd().endsWith('</plist>')).toBe(true)
  })
})
