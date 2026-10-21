#!/usr/bin/env node

import { Command } from 'commander'
import { resolve } from 'node:path'
import { loadManifest, loadRotationConfig } from './manifest.js'
import { reconcileOidcClients, type OidcReconcileResult } from './reconcile-oidc.js'
import { reconcileGitHubSecrets, defaultReadOpField as readOpField, type GitHubReconcileResult } from './reconcile-github.js'
import { computeRender, writeEnvFile, type RenderResult } from './render.js'
import { rotateDatabase, rotateSecret } from './rotate.js'
import { validateRotationConfig } from './config-validation.js'
import { resolveToolEnv } from './resolve-tool-env.js'
import { OnePasswordSecretStore } from './adapters/onepassword.js'
import { NeonDatabaseProvider } from './adapters/neon.js'
import { PostgresIdpDatabaseWriter } from './adapters/idp-postgres.js'
import { GitHubCISecretStore } from './adapters/github.js'
import { verifyGitHubSecrets } from './verify-github.js'
import { checkStaleness, loadRotationState, recordRotation, rotationKey } from './rotation-state.js'
import { reconcileClaudeCode, type ClaudeCodeReconcileResult } from './reconcile-claude-code.js'
import { selectDue } from './due.js'
import { resolveGitHubToken } from './github-token.js'
import { notify } from './notify.js'
import { installSchedule, packageVersion, scheduleStatus, uninstallSchedule } from './schedule.js'
import type { Adapters, RotationConfig, RotationOutcome, RotationStalenessWarning, GitHubSecretVerification } from './types.js'

function getRepoRoot(): string {
  return resolve(process.cwd())
}

function requireEnv(key: string): string {
  // biome-ignore lint/nursery/noProcessEnv: CLI entry point reads env vars directly
  const v = process.env[key]
  if (!v) {
    console.error(`Error: ${key} environment variable is required`)
    process.exit(1)
  }
  return v
}

async function bootstrapEnv(root: string): Promise<void> {
  const config = loadRotationConfig(root)
  await resolveToolEnv(config.toolEnv, new OnePasswordSecretStore())
}

/** Neon is only needed for database rotation and OIDC client reconciliation. */
function usesNeon(config: RotationConfig): boolean {
  return config.databases.length > 0 || config.secrets.some((s) => s.type === 'idp-client')
}

function buildAdapters(opts: { needsDb?: boolean; needsGithub?: boolean } = {}): Adapters {
  const adapters: Adapters = {
    secrets: new OnePasswordSecretStore(),
  }
  if (opts.needsDb) {
    adapters.database = new NeonDatabaseProvider(requireEnv('NEON_API_KEY'))
    adapters.idpDatabase = new PostgresIdpDatabaseWriter()
  }
  const githubToken = opts.needsGithub ? resolveGitHubToken() : undefined
  if (githubToken) {
    adapters.ciSecrets = new GitHubCISecretStore(githubToken)
  }
  return adapters
}

function printGitHubVerification(results: GitHubSecretVerification[]): void {
  if (results.length === 0) return

  // Group by repo
  const byRepo = new Map<string, GitHubSecretVerification[]>()
  for (const r of results) {
    const list = byRepo.get(r.repo) ?? []
    list.push(r)
    byRepo.set(r.repo, list)
  }

  for (const [repo, secrets] of byRepo) {
    console.log(`GitHub Secrets (${repo}):`)
    for (const s of secrets) {
      if (s.status === 'ok') {
        console.log(`  ${s.secretName}: OK`)
      } else if (s.status === 'unverified') {
        console.log(`  ${s.secretName}: UNVERIFIED (no fingerprint variable)`)
      } else {
        console.log(`  ${s.secretName}: MISMATCH (op: ${s.opFingerprint} github: ${s.githubFingerprint})`)
      }
    }
    console.log()
  }
}

function printGitHubReconcile(results: GitHubReconcileResult[]): void {
  if (results.length === 0) return
  console.log('\nGitHub Secret Reconciliation:')
  for (const r of results) {
    const icon = r.status === 'ok' ? '=' : r.status === 'updated' ? '+' : 'x'
    const label = `  ${icon} ${r.secretName} (${r.repo})`
    if (r.status === 'ok') {
      console.log(`${label}: in sync`)
    } else if (r.status === 'updated') {
      console.log(`${label}: updated`)
    } else {
      console.log(`${label}: ${r.status} — ${r.error}`)
    }
  }
  console.log()
}

function printOidcReconcile(results: OidcReconcileResult[]): void {
  if (results.length === 0) return
  console.log('\nOIDC Client Secrets (IDP Database):')
  for (const r of results) {
    const icon = r.status === 'ok' ? '=' : r.status === 'updated' ? '+' : r.status === 'drift' ? '!' : 'x'
    const label = `  ${icon} ${r.clientId} (${r.secretName})`
    if (r.status === 'ok') {
      console.log(`${label}: in sync`)
    } else if (r.status === 'updated') {
      console.log(`${label}: updated`)
    } else if (r.status === 'drift') {
      console.log(`${label}: DRIFT (db != 1password)`)
    } else {
      console.log(`${label}: ${r.status} — ${r.error}`)
    }
  }
  console.log()
}

function printRotation(results: RotationOutcome[]): void {
  console.log('\n' + '-'.repeat(60))
  console.log('Rotation Summary')
  console.log('-'.repeat(60))
  for (const r of results) {
    const icon = r.status === 'ok' ? '+' : r.status === 'error' ? 'x' : '~'
    const label = `${icon} ${r.name}/${r.env}`.padEnd(35)
    if (r.status === 'ok') {
      console.log(`${label} ok`)
    } else if (r.status === 'dry-run') {
      console.log(`${label} dry-run`)
    } else if (r.status === 'skipped') {
      console.log(`${label} skipped  ${r.error ?? ''}`)
    } else {
      console.log(`${label} FAILED`)
      console.log(`  ${r.error}`)
    }
  }
  console.log('-'.repeat(60))
}

function printClaudeCodeReconcile(results: ClaudeCodeReconcileResult[]): void {
  if (results.length === 0) return
  console.log('\nClaude Code MCP Reconciliation:')
  for (const r of results) {
    const icon = r.status === 'ok' ? '=' : r.status === 'updated' ? '+' : 'x'
    const label = `${r.mcpServer} → ${r.target}`
    if (r.status === 'error') {
      console.log(`  ${icon} ${label}: ${r.error}`)
    } else {
      console.log(`  ${icon} ${label}: ${r.status}`)
    }
  }
}

function printStalenessWarnings(warnings: RotationStalenessWarning[]): void {
  if (warnings.length === 0) return
  console.log('\nRotation Staleness Warnings:')
  for (const w of warnings) {
    const age = w.daysSinceRotation === -1 ? 'never rotated' : `${w.daysSinceRotation}d since last rotation`
    console.log(`  ! ${w.name}: ${age} (interval: ${w.rotationIntervalDays}d)`)
  }
  console.log()
}

function printRender(result: RenderResult, outPath?: string): void {
  const secretSet = new Set(result.secretKeys)
  const total = Object.keys(result.env).length
  const summary = `${total} vars (${result.secretKeys.length} secret, ${result.literalKeys.length} literal)`
  console.log(outPath ? `Wrote ${summary} to ${outPath}` : `[DRY RUN] ${summary}:`)
  for (const key of Object.keys(result.env)) {
    console.log(`  ${key}=${secretSet.has(key) ? '******' : result.env[key]}`)
  }
}

const program = new Command()
  .name('environment-manager')
  .description('Declarative environment variable sync, secret rotation, and verification')
  .version(packageVersion())
  .addHelpText('after', `
Examples:
  environment-manager render production --dry-run     Preview production.manifest.yaml resolved (secrets masked)
  environment-manager render production --out .env    Write it to .env
  environment-manager verify production               Check GitHub Actions secrets match 1Password
  environment-manager sync production --apply         Push 1Password values to GitHub and OIDC clients
  environment-manager rotate production               Preview a rotation (add --apply to rotate)

Run from the repo root. Config lives in .environment-manager/.`)
  .action(() => {
    program.help({ error: false })
  })

program
  .command('sync')
  .argument('<env>', 'Environment key in rotation.yaml: preview or production')
  .option('--apply', 'Actually reconcile (default is dry-run)', false)
  .description('Reconcile 1Password values into the IDP database, GitHub secrets and Claude Code')
  .action(async (env: string, opts: { apply: boolean }) => {
    const root = getRepoRoot()
    await bootstrapEnv(root)
    const rotationConfig = loadRotationConfig(root)
    const adapters = buildAdapters({ needsDb: usesNeon(rotationConfig), needsGithub: true })

    // OIDC client secrets: the database accepts both old and new secrets
    // before anything starts presenting the new one.
    const oidcResults = await reconcileOidcClients(rotationConfig, env, adapters, undefined, { dryRun: !opts.apply })
    printOidcReconcile(oidcResults)

    if (adapters.ciSecrets) {
      if (opts.apply) {
        printGitHubReconcile(await reconcileGitHubSecrets(rotationConfig.secrets, env, adapters.ciSecrets))
      } else {
        printGitHubVerification(await verifyGitHubSecrets(rotationConfig.secrets, env, adapters.ciSecrets))
      }
    }

    // Reconcile Claude Code MCP server env vars / headers
    if (opts.apply) {
      const ccResults = await reconcileClaudeCode(rotationConfig.secrets, env, readOpField)
      printClaudeCodeReconcile(ccResults)
    }

    // Check for stale external secrets that need manual rotation
    const stalenessWarnings = checkStaleness(rotationConfig.secrets, env, root)
    printStalenessWarnings(stalenessWarnings)
  })

program
  .command('rotate')
  .argument('<env>', 'Environment key in rotation.yaml: preview or production')
  .option('--apply', 'Actually rotate (default is dry-run)', false)
  .option('--service <name>', 'Rotate only one DB service')
  .option('--secret <name>', 'Rotate only one secret')
  .option('--mode <mode>', 'db, secrets, or all', 'all')
  .option('--due', 'Only what rotationIntervalDays says is due (what `schedule` runs)', false)
  .option('--notify', 'Post a desktop notification with the outcome (macOS)', false)
  .description('Rotate credentials to 1Password, then reconcile the IDP database and GitHub secrets.')
  .option('--skip-sync', 'Skip the automatic reconcile after rotation', false)
  .action(async (env: string, opts: {
    apply: boolean
    service?: string
    secret?: string
    mode: string
    due: boolean
    notify: boolean
    skipSync: boolean
  }) => {
    const root = getRepoRoot()
    try {
      await runRotate(root, env, opts)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      console.error(`Rotation failed: ${message}`)
      // The message can quote tool output; keep it out of Notification Center.
      if (opts.notify) await notify('environment-manager', `Rotation failed in ${env}. See the log.`)
      process.exit(1)
    }
  })

async function runRotate(root: string, env: string, opts: {
  apply: boolean
  service?: string
  secret?: string
  mode: string
  due: boolean
  notify: boolean
  skipSync: boolean
}): Promise<void> {
  const rotationConfig = loadRotationConfig(root)
  const errors = validateRotationConfig(rotationConfig)
  if (errors.length) {
    throw new Error(`config validation failed:\n${errors.map((e) => `  x ${e}`).join('\n')}`)
  }

  let dbs = opts.mode === 'db' || opts.mode === 'all'
    ? rotationConfig.databases.filter((d) => !opts.service || d.name === opts.service)
    : []
  let secrets = opts.mode === 'secrets' || opts.mode === 'all'
    ? rotationConfig.secrets.filter((s) => !opts.secret || s.name === opts.secret)
    : []

  if (opts.due) {
    const state = loadRotationState(root)
    const key = (item: { name: string }) => rotationKey(env, item.name)
    dbs = selectDue(dbs, state, new Date(), key)
    secrets = selectDue(
      secrets.filter((s) => s.environments.includes(env) && s.type !== 'external' && !s.skipRotation),
      state,
      new Date(),
      key,
    )
    printStalenessWarnings(checkStaleness(rotationConfig.secrets, env, root))
    if (dbs.length === 0 && secrets.length === 0) {
      console.log(`${new Date().toISOString()} nothing due for rotation in ${env}`)
      return
    }
    console.log(`${new Date().toISOString()} due in ${env}: ${[...dbs, ...secrets].map((i) => i.name).join(', ')}`)
  }

  await bootstrapEnv(root)
  const adapters = buildAdapters({ needsDb: usesNeon(rotationConfig), needsGithub: true })

  const dryRun = !opts.apply
  const allResults: RotationOutcome[] = []
  for (const db of dbs) {
    allResults.push(...await rotateDatabase(db, env, adapters, dryRun))
  }
  for (const secret of secrets) {
    allResults.push(...await rotateSecret(secret, env, adapters, dryRun))
  }

  printRotation(allResults)

  if (!opts.due) {
    // Check for stale external secrets that need manual rotation
    printStalenessWarnings(checkStaleness(rotationConfig.secrets, env, root))
  }

  // Record successful rotations, even when others failed, so a retry only
  // redoes what is still due.
  if (opts.apply) {
    for (const r of allResults) {
      if (r.status === 'ok') recordRotation(root, rotationKey(env, r.name))
    }
  }

  const failed = allResults.filter((r) => r.status === 'error')
  if (failed.length) {
    if (opts.notify) {
      await notify('environment-manager', `Rotation failed in ${env}: ${failed.map((r) => r.name).join(', ')}. See the log.`)
    }
    process.exit(1)
  }

  // After a successful rotation, reconcile OIDC + GitHub secrets so the IDP
  // database and CI never drift from 1Password.
  if (opts.apply && !opts.skipSync) {
    console.log('\n' + '='.repeat(60))
    console.log('Reconciling rotated values into the IDP database and GitHub...')
    console.log('='.repeat(60) + '\n')

    const oidcResults = await reconcileOidcClients(rotationConfig, env, adapters)
    printOidcReconcile(oidcResults)

    if (adapters.ciSecrets) {
      const ghResults = await reconcileGitHubSecrets(rotationConfig.secrets, env, adapters.ciSecrets)
      printGitHubReconcile(ghResults)
    }

    console.log('\n' + '='.repeat(60))
    console.log('Rotation complete. Re-render any .env files (environment-manager render)')
    console.log('so services pick up the rotated values.')
    console.log('='.repeat(60))
  }

  const rotated = allResults.filter((r) => r.status === 'ok').map((r) => r.name)
  if (opts.notify && opts.apply && rotated.length) {
    await notify('environment-manager', `Rotated in ${env}: ${rotated.join(', ')}`)
  }
}

program
  .command('record')
  .argument('<env>', 'Environment key in rotation.yaml')
  .argument('<name>', 'Secret or database name from rotation.yaml')
  .description('Record that a credential was rotated by hand, restarting its rotationIntervalDays clock')
  .action((env: string, name: string) => {
    const root = getRepoRoot()
    const config = loadRotationConfig(root)
    const known = [...config.databases, ...config.secrets].some((i) => i.name === name)
    if (!known) {
      console.error(`Error: "${name}" is not a database or secret in rotation.yaml`)
      process.exit(1)
    }
    recordRotation(root, rotationKey(env, name))
    console.log(`Recorded ${name} as rotated in ${env} now.`)
  })

const schedule = program
  .command('schedule')
  .description('Run `rotate <env> --due --apply` at login and daily via a macOS LaunchAgent')

schedule
  .command('install')
  .argument('<env>', 'Environment key in rotation.yaml')
  .option('--hour <hour>', 'Hour of day (0-23) for the daily run', '10')
  .description('Install (or refresh) the LaunchAgent for this repo and environment, pinned to this release')
  .action(async (env: string, opts: { hour: string }) => {
    const hour = Number.parseInt(opts.hour, 10)
    if (!(hour >= 0 && hour <= 23)) {
      console.error('Error: --hour must be 0-23')
      process.exit(1)
    }
    const result = await installSchedule(getRepoRoot(), env, hour)
    console.log(`Installed ${result.label}`)
    console.log(`  runs:  ${result.command.join(' ')}`)
    console.log(`  when:  at login, and daily at ${String(hour).padStart(2, '0')}:00`)
    console.log(`  log:   ${result.logPath}`)
    console.log(`  plist: ${result.plistPath}`)
    console.log('It runs once now. Re-run install after upgrading this package to move the pin.')
  })

schedule
  .command('uninstall')
  .argument('<env>', 'Environment key in rotation.yaml')
  .description('Remove the LaunchAgent for this repo and environment')
  .action(async (env: string) => {
    const { label, removed } = await uninstallSchedule(getRepoRoot(), env)
    console.log(removed ? `Removed ${label}` : `${label} was not installed`)
  })

schedule
  .command('status')
  .argument('<env>', 'Environment key in rotation.yaml')
  .description('Show whether the LaunchAgent is installed, its pinned release, and recent log lines')
  .action(async (env: string) => {
    const root = getRepoRoot()
    const s = await scheduleStatus(root, env)
    console.log(`${s.label}: ${s.installed ? (s.loaded ? 'installed, loaded' : 'installed, NOT loaded') : 'not installed'}`)
    if (s.pinnedVersion) {
      const current = packageVersion()
      console.log(`  pinned release: ${s.pinnedVersion}${s.pinnedVersion === current ? '' : ` (this is ${current}; re-run install to move the pin)`}`)
    }
    if (s.lastExitCode) console.log(`  last exit code: ${s.lastExitCode}`)
    console.log(`  log: ${s.logPath}`)
    for (const line of s.logTail) console.log(`    ${line}`)

    const config = loadRotationConfig(root)
    const state = loadRotationState(root)
    const scheduled = [...config.databases, ...config.secrets.filter((x) => x.environments.includes(env))]
      .filter((i) => i.rotationIntervalDays)
    if (scheduled.length) {
      console.log('  intervals:')
      for (const i of scheduled) {
        const last = state.lastRotated[rotationKey(env, i.name)]
        console.log(`    ${i.name}: every ${i.rotationIntervalDays}d, last ${last ? last.slice(0, 10) : 'never'}`)
      }
    }
  })

program
  .command('verify')
  .argument('<env>', 'Environment key in rotation.yaml: preview or production')
  .description('Verify GitHub Actions secrets match 1Password values via fingerprint comparison')
  .action(async (env: string) => {
    const root = getRepoRoot()
    await bootstrapEnv(root)
    const rotationConfig = loadRotationConfig(root)
    const adapters = buildAdapters({ needsGithub: true })

    if (!adapters.ciSecrets) {
      console.error('Error: a GitHub token is required for verify: set GITHUB_TOKEN or log in with `gh auth login`')
      process.exit(1)
    }

    const results = await verifyGitHubSecrets(rotationConfig.secrets, env, adapters.ciSecrets)
    printGitHubVerification(results)

    if (results.length === 0) {
      console.log('No GitHub secrets configured for this environment.')
      return
    }

    const hasIssues = results.some((r) => r.status === 'mismatch' || r.status === 'unverified')
    if (hasIssues) {
      process.exit(1)
    }
  })

program
  .command('render')
  .argument('<name>', 'Manifest name: .environment-manager/<name>.manifest.yaml')
  .option('--out <path>', 'Output .env path', './.env')
  .option('--project <name>', 'Merge this project block on top of shared')
  .option('--dry-run', 'Resolve and list keys (secrets masked) without writing', false)
  .description('Render a .env file from a manifest, resolving op:// references from 1Password')
  .action(async (name: string, opts: { out: string; project?: string; dryRun: boolean }) => {
    const root = getRepoRoot()
    // Resolution only needs 1Password (`op` must be authenticated: desktop app
    // locally, or OP_SERVICE_ACCOUNT_TOKEN in CI). No DB or GitHub adapters, so we
    // construct the secret store directly rather than via buildAdapters().
    const manifest = loadManifest(root, name)
    const secrets = new OnePasswordSecretStore()
    const result = await computeRender(manifest, { project: opts.project, secrets })
    if (opts.dryRun) {
      printRender(result)
      return
    }
    writeEnvFile(opts.out, result.env)
    printRender(result, opts.out)
  })

program.parse()
