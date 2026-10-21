import { resolveOpField, readOpItemField } from './op-field.js'
import type {
  Adapters,
  RotationConfig,
  SecretRotationConfig,
} from './types.js'

export interface OidcReconcileResult {
  clientId: string
  secretName: string
  status: 'ok' | 'updated' | 'drift' | 'not-found' | 'error'
  error?: string
}

export type SecretReader = (itemId: string, field: string) => Promise<string>

const defaultReadOpField = readOpItemField

export async function reconcileOidcClients(
  rotationConfig: RotationConfig,
  env: string,
  adapters: Adapters,
  readSecret: SecretReader = defaultReadOpField,
  options: { dryRun?: boolean } = {},
): Promise<OidcReconcileResult[]> {
  const results: OidcReconcileResult[] = []

  const idpClientSecrets = rotationConfig.secrets.filter(
    (s): s is SecretRotationConfig & { oidcClientId: string; idpDatabase: string } =>
      s.type === 'idp-client'
      && s.environments.includes(env)
      && !!s.oidcClientId
      && !!s.idpDatabase,
  )

  if (idpClientSecrets.length === 0) return results
  if (!adapters.database || !adapters.idpDatabase) {
    console.warn('[reconcile-oidc] Skipping: database adapters not available')
    return results
  }

  for (const secret of idpClientSecrets) {
    const dbConfig = rotationConfig.databases.find(d => d.name === secret.idpDatabase)
    if (!dbConfig) {
      results.push({
        clientId: secret.oidcClientId,
        secretName: secret.name,
        status: 'error',
        error: `database config "${secret.idpDatabase}" not found in rotation.yaml`,
      })
      continue
    }

    if (!secret.onePassword) {
      results.push({
        clientId: secret.oidcClientId,
        secretName: secret.name,
        status: 'error',
        error: 'no onePassword config for this secret',
      })
      continue
    }

    // Resolve expected value from 1Password (same convention as rotate: preview appends _preview)
    let expectedValue: string
    try {
      const opField = resolveOpField(secret.onePassword.field, env)
      expectedValue = await readSecret(secret.onePassword.itemId, opField)
    } catch (err) {
      results.push({
        clientId: secret.oidcClientId,
        secretName: secret.name,
        status: 'error',
        error: `failed to resolve 1Password value: ${err}`,
      })
      continue
    }

    // Get IDP database connection URI
    let connectionUri: string
    try {
      const branchId = env === 'preview'
        ? dbConfig.neon.previewBranchId
        : dbConfig.neon.productionBranchId
      connectionUri = await adapters.database.getConnectionUri(
        dbConfig.neon.projectId, branchId, dbConfig.neon.roleName,
      )
    } catch (err) {
      results.push({
        clientId: secret.oidcClientId,
        secretName: secret.name,
        status: 'error',
        error: `failed to get DB connection URI: ${err}`,
      })
      continue
    }

    // Read current DB value and compare
    try {
      const currentSecret = await adapters.idpDatabase.readOidcClientSecret(connectionUri, secret.oidcClientId)

      if (currentSecret === null) {
        results.push({
          clientId: secret.oidcClientId,
          secretName: secret.name,
          status: 'not-found',
          error: `oidc client "${secret.oidcClientId}" not found in database`,
        })
        continue
      }

      if (currentSecret === expectedValue) {
        results.push({
          clientId: secret.oidcClientId,
          secretName: secret.name,
          status: 'ok',
        })
      } else if (options.dryRun) {
        results.push({
          clientId: secret.oidcClientId,
          secretName: secret.name,
          status: 'drift',
        })
      } else {
        await adapters.idpDatabase.updateOidcClientSecret(connectionUri, secret.oidcClientId, expectedValue)
        results.push({
          clientId: secret.oidcClientId,
          secretName: secret.name,
          status: 'updated',
        })
      }
    } catch (err) {
      results.push({
        clientId: secret.oidcClientId,
        secretName: secret.name,
        status: 'error',
        error: `database operation failed: ${err}`,
      })
    }
  }

  return results
}
