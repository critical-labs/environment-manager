import { computeFingerprint } from './fingerprint.js'
import { resolveOpField, readOpItemField } from './op-field.js'
import type {
  CISecretStore,
  SecretRotationConfig,
} from './types.js'

export interface GitHubReconcileResult {
  secretName: string
  repo: string
  status: 'ok' | 'updated' | 'error'
  error?: string
}

export type SecretReader = (itemId: string, field: string) => Promise<string>

export const defaultReadOpField = readOpItemField

interface GitHubTarget {
  owner: string
  repo: string
  secretName: string
}

function getGitHubTargets(secret: SecretRotationConfig): GitHubTarget[] {
  const targets: GitHubTarget[] = []

  if (secret.github) {
    for (const gh of secret.github) {
      targets.push({ owner: gh.owner, repo: gh.repo, secretName: gh.secretName })
    }
  }

  if (secret.type === 'op-service-account' && secret.opServiceAccount) {
    const [owner, repo] = secret.opServiceAccount.githubRepo.split('/')
    targets.push({ owner, repo, secretName: secret.opServiceAccount.githubSecretName })
  }

  return targets
}

export async function reconcileGitHubSecrets(
  secrets: SecretRotationConfig[],
  env: string,
  ciSecrets: CISecretStore,
  readSecret: SecretReader = defaultReadOpField,
): Promise<GitHubReconcileResult[]> {
  const results: GitHubReconcileResult[] = []

  for (const secret of secrets) {
    if (!secret.environments.includes(env)) continue
    if (!secret.onePassword) continue

    const targets = getGitHubTargets(secret)
    if (targets.length === 0) continue

    let opValue: string
    try {
      const opField = resolveOpField(secret.onePassword.field, env)
      opValue = await readSecret(secret.onePassword.itemId, opField)
    } catch (err) {
      for (const target of targets) {
        results.push({
          secretName: target.secretName,
          repo: `${target.owner}/${target.repo}`,
          status: 'error',
          error: `failed to resolve 1Password value: ${err}`,
        })
      }
      continue
    }

    const opFp = computeFingerprint(opValue)

    for (const target of targets) {
      try {
        const ghFp = await ciSecrets.getFingerprint(target.owner, target.repo, target.secretName)

        if (ghFp === opFp) {
          results.push({
            secretName: target.secretName,
            repo: `${target.owner}/${target.repo}`,
            status: 'ok',
          })
        } else {
          await ciSecrets.upsertSecret(target.owner, target.repo, target.secretName, opValue)
          await ciSecrets.upsertFingerprint(target.owner, target.repo, target.secretName, opFp)
          results.push({
            secretName: target.secretName,
            repo: `${target.owner}/${target.repo}`,
            status: 'updated',
          })
        }
      } catch (err) {
        results.push({
          secretName: target.secretName,
          repo: `${target.owner}/${target.repo}`,
          status: 'error',
          error: `GitHub operation failed: ${err}`,
        })
      }
    }
  }

  return results
}
