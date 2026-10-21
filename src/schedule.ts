import { execFile, execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, delimiter, dirname, join } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export const PACKAGE_NAME = '@critical-labs/environment-manager'

export function packageVersion(): string {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf-8'))
  return pkg.version
}

export function scheduleLabel(repoRoot: string, env: string): string {
  const slug = basename(repoRoot).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
  return `com.critical-labs.environment-manager.${slug}.${env}`
}

/** What the agent runs: the release that installed it, so a run never drifts. */
export function scheduledCommand(npxPath: string, version: string, env: string): string[] {
  return [npxPath, '--yes', `${PACKAGE_NAME}@${version}`, 'rotate', env, '--due', '--apply', '--notify']
}

function xml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

export interface LaunchAgentSpec {
  label: string
  programArguments: string[]
  workingDirectory: string
  path: string
  logPath: string
  hour: number
}

export function buildLaunchAgentPlist(spec: LaunchAgentSpec): string {
  const args = spec.programArguments.map((a) => `    <string>${xml(a)}</string>`).join('\n')
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xml(spec.label)}</string>
  <key>ProgramArguments</key>
  <array>
${args}
  </array>
  <key>WorkingDirectory</key>
  <string>${xml(spec.workingDirectory)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${xml(spec.path)}</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Hour</key>
    <integer>${spec.hour}</integer>
    <key>Minute</key>
    <integer>0</integer>
  </dict>
  <key>StandardOutPath</key>
  <string>${xml(spec.logPath)}</string>
  <key>StandardErrorPath</key>
  <string>${xml(spec.logPath)}</string>
</dict>
</plist>
`
}

function findOnPath(command: string): string | undefined {
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (dir && existsSync(join(dir, command))) return join(dir, command)
  }
  return undefined
}

function paths(label: string) {
  return {
    plist: join(homedir(), 'Library', 'LaunchAgents', `${label}.plist`),
    log: join(homedir(), 'Library', 'Logs', 'environment-manager', `${label.replace('com.critical-labs.environment-manager.', '')}.log`),
  }
}

function domain(): string {
  return `gui/${process.getuid?.() ?? execFileSync('id', ['-u'], { encoding: 'utf-8' }).trim()}`
}

function assertMacOS(): void {
  if (process.platform !== 'darwin') {
    throw new Error('schedule uses launchd and is macOS-only; elsewhere, run `environment-manager rotate <env> --due --apply` from cron or CI')
  }
}

export interface InstallResult {
  label: string
  plistPath: string
  logPath: string
  command: string[]
}

export async function installSchedule(repoRoot: string, env: string, hour = 10): Promise<InstallResult> {
  assertMacOS()
  const label = scheduleLabel(repoRoot, env)
  const { plist, log } = paths(label)
  const npx = join(dirname(process.execPath), 'npx')
  if (!existsSync(npx)) throw new Error(`npx not found beside node at ${npx}`)

  // launchd starts agents with a bare PATH: carry the directories of node, op, and gh.
  const dirs = [dirname(process.execPath)]
  for (const tool of ['op', 'gh']) {
    const found = findOnPath(tool)
    if (!found) throw new Error(`${tool} is not on PATH; rotation needs it`)
    dirs.push(dirname(found))
  }
  dirs.push('/usr/bin', '/bin', '/usr/sbin', '/sbin')

  const command = scheduledCommand(npx, packageVersion(), env)
  mkdirSync(dirname(plist), { recursive: true })
  mkdirSync(dirname(log), { recursive: true })
  writeFileSync(plist, buildLaunchAgentPlist({
    label,
    programArguments: command,
    workingDirectory: repoRoot,
    path: [...new Set(dirs)].join(':'),
    logPath: log,
    hour,
  }))

  await execFileAsync('launchctl', ['bootout', `${domain()}/${label}`]).catch(() => {})
  await execFileAsync('launchctl', ['bootstrap', domain(), plist])
  return { label, plistPath: plist, logPath: log, command }
}

export async function uninstallSchedule(repoRoot: string, env: string): Promise<{ label: string; removed: boolean }> {
  assertMacOS()
  const label = scheduleLabel(repoRoot, env)
  const { plist } = paths(label)
  await execFileAsync('launchctl', ['bootout', `${domain()}/${label}`]).catch(() => {})
  const removed = existsSync(plist)
  rmSync(plist, { force: true })
  return { label, removed }
}

export interface ScheduleStatus {
  label: string
  installed: boolean
  loaded: boolean
  pinnedVersion?: string
  lastExitCode?: string
  plistPath: string
  logPath: string
  logTail: string[]
}

export async function scheduleStatus(repoRoot: string, env: string): Promise<ScheduleStatus> {
  assertMacOS()
  const label = scheduleLabel(repoRoot, env)
  const { plist, log } = paths(label)
  const installed = existsSync(plist)
  const pinnedVersion = installed
    ? readFileSync(plist, 'utf-8').match(new RegExp(`${PACKAGE_NAME.replace('/', '\\/')}@([^<]+)<`))?.[1]
    : undefined

  let loaded = false
  let lastExitCode: string | undefined
  try {
    const { stdout } = await execFileAsync('launchctl', ['print', `${domain()}/${label}`])
    loaded = true
    lastExitCode = stdout.match(/last exit code = (.+)/)?.[1]?.trim()
  } catch {
    // not loaded
  }

  const logTail = existsSync(log) ? readFileSync(log, 'utf-8').trimEnd().split('\n').slice(-15) : []
  return { label, installed, loaded, pinnedVersion, lastExitCode, plistPath: plist, logPath: log, logTail }
}
