import { randomBytes } from 'node:crypto'
import { resolveOpField } from './op-field.js'
import type {
  Adapters,
  DatabaseRotationConfig,
  SecretRotationConfig,
  RotationOutcome,
} from './types.js'

// ---------------------------------------------------------------------------
// rotateDatabase
// ---------------------------------------------------------------------------

export async function rotateDatabase(
  db: DatabaseRotationConfig,
  env: string,
  adapters: Adapters,
  dryRun: boolean,
): Promise<RotationOutcome[]> {
  if (dryRun) {
    return [{ name: db.name, env, status: 'dry-run' }]
  }

  const branchId = env === 'preview'
    ? db.neon.previewBranchId
    : db.neon.productionBranchId

  // 1. Reset role password — returns the authoritative new password
  const newPassword = await adapters.database!.resetRolePassword(db.neon.projectId, branchId, db.neon.roleName)

  // 2. Get connection URI and verify password matches
  let connectionUri = await adapters.database!.getConnectionUri(db.neon.projectId, branchId, db.neon.roleName)
  const parsed = new URL(connectionUri)
  if (parsed.password !== newPassword) {
    console.warn(`[rotate] ${db.name}: getConnectionUri returned a stale password; substituting the reset password`)
    parsed.password = newPassword
    connectionUri = parsed.toString()
  }

  // 3. Write to 1Password — MUST succeed, otherwise 1OP goes stale. The
  //    servers read it from there when their .env is next rendered.
  const opField = resolveOpField(db.onePassword.field, env)
  await adapters.secrets.write(db.onePassword.itemId, opField, connectionUri)

  return [{ name: db.name, env, status: 'ok' }]
}

// ---------------------------------------------------------------------------
// rotateSecret
// ---------------------------------------------------------------------------

export async function rotateSecret(
  secret: SecretRotationConfig,
  env: string,
  adapters: Adapters,
  dryRun: boolean,
): Promise<RotationOutcome[]> {
  // Skip if env not in secret.environments
  if (!secret.environments.includes(env)) {
    return []
  }

  if (secret.type === 'external') {
    return [{ name: secret.name, env, status: 'skipped', error: 'external secrets are not rotated' }]
  }

  if (secret.skipRotation) {
    return [{ name: secret.name, env, status: 'skipped', error: 'skipRotation is set' }]
  }

  if (dryRun) {
    return [{ name: secret.name, env, status: 'dry-run' }]
  }

  // Generate or read value based on type
  let value: string

  switch (secret.type) {
    case 'random': {
      if (secret.format === 'alphanumeric') {
        const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
        const len = secret.byteLength ?? 32
        const bytes = randomBytes(len * 2)
        let result = ''
        for (let i = 0; i < bytes.length && result.length < len; i++) {
          if (bytes[i] < 248) {
            result += chars[bytes[i] % 62]
          }
        }
        value = result
      } else {
        value = randomBytes(secret.byteLength ?? 32).toString('hex')
      }
      break
    }
    case 'idp-client': {
      // Generate new secret value — DB update is handled by sync --apply via reconcileOidcClients
      value = randomBytes(secret.byteLength ?? 32).toString('hex')
      break
    }
    case 'op-service-account': {
      const cfg = secret.opServiceAccount
      if (!cfg) {
        return [{ name: secret.name, env, status: 'error', error: 'op-service-account requires opServiceAccount config' }]
      }

      // This type requires full user auth — fail if running as service account
      // biome-ignore lint/nursery/noProcessEnv: must check env directly
      if (process.env.OP_SERVICE_ACCOUNT_TOKEN) {
        return [{
          name: secret.name,
          env,
          status: 'error',
          error: 'op-service-account rotation requires full user auth. Unset OP_SERVICE_ACCOUNT_TOKEN and sign in as a user.',
        }]
      }

      const { execFile } = await import('node:child_process')
      const { promisify } = await import('node:util')
      const execFileAsync = promisify(execFile)

      console.log(`[rotate] Creating new 1Password service account "${cfg.accountName}"...`)
      const { stdout: token } = await execFileAsync('op', [
        'service-account', 'create', cfg.accountName,
        `--expires-in=${cfg.expiresIn}`,
        `--vault=${cfg.vault}:${cfg.permissions}`,
        '--raw',
      ])
      value = token.trim()
      console.log(`[rotate] Service account created (token length: ${value.length})`)

      // The account exists now: store its token before anything else can fail.
      if (secret.onePassword) {
        await adapters.secrets.write(secret.onePassword.itemId, resolveOpField(secret.onePassword.field, env), value)
      }

      // biome-ignore lint/nursery/noProcessEnv: the scheduled job sets it
      if (process.env.EM_SCHEDULED) {
        console.log(`[rotate] Scheduled run: left ${cfg.settingsLocalPath} alone; run \`environment-manager sync ${env} --apply\` in the repository to update it`)
      } else {
        try {
          const { writeSettingsToken } = await import('./settings-local.js')
          writeSettingsToken(cfg.settingsLocalPath, value)
          console.log(`[rotate] Updated ${cfg.settingsLocalPath}`)
        } catch (err) {
          console.warn(`[rotate] Could not update ${cfg.settingsLocalPath} (${(err as Error).message}); the token is in 1Password, run \`environment-manager sync ${env} --apply\` to retry`)
        }
      }
      return [{ name: secret.name, env, status: 'ok' }]
    }
    case 'github-pat': {
      return [{
        name: secret.name,
        env,
        status: 'error',
        error: 'GitHub has no API to create fine-grained PATs: create one by hand, write it to 1Password, run `environment-manager sync`, then `environment-manager record ' + secret.name + '`',
      }]
    }
  }

  // Write to 1Password if configured — MUST succeed, or 1Password (which the
  // rendered .env files and GitHub secrets are built from) goes stale.
  // Convention: production uses the base field, preview appends _preview
  // (same convention as rotateDatabase).
  if (secret.onePassword) {
    const opField = resolveOpField(secret.onePassword.field, env)
    await adapters.secrets.write(secret.onePassword.itemId, opField, value)
  }

  // GitHub push is handled by sync --apply via reconcileGitHubSecrets

  return [{ name: secret.name, env, status: 'ok' }]
}
