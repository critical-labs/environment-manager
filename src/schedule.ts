import { execFile, execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, delimiter, dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { dataDir, loadRotationState, saveRotationState, stateFile } from './rotation-state.js'

const execFileAsync = promisify(execFile)

export const PACKAGE_NAME = '@critical-labs/environment-manager'
const REGISTRY = 'https://registry.npmjs.org/'
const CONFIG_REL = join('.environment-manager', 'rotation.yaml')

export function packageVersion(): string {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf-8'))
  return pkg.version
}

export function scheduleLabel(repoRoot: string, env: string): string {
  const slug = basename(repoRoot).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
  return `com.critical-labs.environment-manager.${slug}.${env}`
}

export function scheduledCommand(nodePath: string, cliPath: string, env: string): string[] {
  return [nodePath, cliPath, 'rotate', env, '--due', '--apply', '--notify']
}

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

/**
 * Copy the repository's rotation.yaml into the data directory. The scheduled
 * job reads only this copy: a change to the repository (a pulled commit, a
 * checked-out branch) takes effect only when someone re-runs `schedule install`.
 */
export function snapshotConfig(repoRoot: string, data: string): string {
  const source = join(repoRoot, CONFIG_REL)
  if (!existsSync(source)) throw new Error(`no ${CONFIG_REL} in ${repoRoot}`)
  const dir = join(data, 'config')
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(join(dir, '.environment-manager'), { recursive: true, mode: 0o700 })
  copyFileSync(source, join(dir, CONFIG_REL))
  writeFileSync(join(data, 'approved.json'), JSON.stringify({
    sha256: sha256(source),
    approvedAt: new Date().toISOString(),
  }, null, 2) + '\n', { mode: 0o600 })
  return dir
}

/** Whether the repository's rotation.yaml differs from the approved snapshot. */
export function configDrift(repoRoot: string, data: string): boolean {
  try {
    const approved = JSON.parse(readFileSync(join(data, 'approved.json'), 'utf-8'))
    return approved.sha256 !== sha256(join(repoRoot, CONFIG_REL))
  } catch {
    return true
  }
}

/**
 * Install this release into the data directory, outside the repository, so the
 * job never runs code the repository's .npmrc or node_modules could swap in.
 * npm checks each tarball against the registry's integrity hash; install
 * scripts are not run.
 */
async function installRuntime(data: string, version: string): Promise<string> {
  const prefix = join(data, `runtime-${version}`)
  const cli = join(prefix, 'node_modules', '@critical-labs', 'environment-manager', 'dist', 'cli.js')
  if (!existsSync(cli)) {
    mkdirSync(prefix, { recursive: true, mode: 0o700 })
    const npm = join(dirname(process.execPath), 'npm')
    await execFileAsync(npm, [
      'install', `${PACKAGE_NAME}@${version}`,
      '--prefix', prefix, '--registry', REGISTRY,
      '--ignore-scripts', '--save-exact', '--no-audit', '--no-fund',
    ], { cwd: prefix })
  }
  const installed = JSON.parse(readFileSync(join(dirname(dirname(cli)), 'package.json'), 'utf-8'))
  if (installed.version !== version) {
    throw new Error(`installed ${PACKAGE_NAME}@${installed.version}, expected ${version}`)
  }
  return cli
}

function xml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

export interface LaunchAgentSpec {
  label: string
  programArguments: string[]
  workingDirectory: string
  environment: Record<string, string>
  logPath: string
  hour: number
}

export function buildLaunchAgentPlist(spec: LaunchAgentSpec): string {
  const args = spec.programArguments.map((a) => `    <string>${xml(a)}</string>`).join('\n')
  const env = Object.entries(spec.environment)
    .map(([k, v]) => `    <key>${xml(k)}</key>\n    <string>${xml(v)}</string>`).join('\n')
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
${env}
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
  dataPath: string
  command: string[]
}

export async function installSchedule(repoRoot: string, env: string, hour = 10): Promise<InstallResult> {
  assertMacOS()
  const label = scheduleLabel(repoRoot, env)
  const { plist, log } = paths(label)
  const data = dataDir(repoRoot)
  mkdirSync(data, { recursive: true, mode: 0o700 })

  // launchd starts agents with a bare PATH: carry the directories of node, op, and gh.
  const dirs = [dirname(process.execPath)]
  for (const tool of ['op', 'gh']) {
    const found = findOnPath(tool)
    if (!found) throw new Error(`${tool} is not on PATH; rotation needs it`)
    dirs.push(dirname(found))
  }
  dirs.push('/usr/bin', '/bin', '/usr/sbin', '/sbin')

  const cli = await installRuntime(data, packageVersion())
  const configDir = snapshotConfig(repoRoot, data)
  // Carry existing history (including a pre-0.3.0 in-repo file) into the data directory.
  saveRotationState(repoRoot, loadRotationState(repoRoot))

  const command = scheduledCommand(process.execPath, cli, env)
  mkdirSync(dirname(plist), { recursive: true })
  mkdirSync(dirname(log), { recursive: true, mode: 0o700 })
  writeFileSync(plist, buildLaunchAgentPlist({
    label,
    programArguments: command,
    workingDirectory: configDir,
    environment: {
      PATH: [...new Set(dirs)].join(':'),
      EM_STATE_FILE: stateFile(repoRoot),
      EM_SCHEDULED: '1',
    },
    logPath: log,
    hour,
  }), { mode: 0o600 })

  await execFileAsync('launchctl', ['bootout', `${domain()}/${label}`]).catch(() => {})
  await execFileAsync('launchctl', ['bootstrap', domain(), plist])
  return { label, plistPath: plist, logPath: log, dataPath: data, command }
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
  configChanged: boolean
  plistPath: string
  logPath: string
  logTail: string[]
}

export async function scheduleStatus(repoRoot: string, env: string): Promise<ScheduleStatus> {
  assertMacOS()
  const label = scheduleLabel(repoRoot, env)
  const { plist, log } = paths(label)
  const installed = existsSync(plist)
  const pinnedVersion = installed ? readFileSync(plist, 'utf-8').match(/runtime-([^/<]+)\//)?.[1] : undefined

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
  return {
    label, installed, loaded, pinnedVersion, lastExitCode,
    configChanged: installed && configDrift(repoRoot, dataDir(repoRoot)),
    plistPath: plist, logPath: log, logTail,
  }
}
