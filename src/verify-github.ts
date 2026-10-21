import { computeFingerprint } from './fingerprint.js'
import { resolveOpField, readOpItemField } from './op-field.js'
import type {
  CISecretStore,
  SecretRotationConfig,
  GitHubSecretVerification,
} from './types.js'

const readOpField = readOpItemField

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

export async function verifyGitHubSecrets(
  secrets: SecretRotationConfig[],
  env: string,
  ciSecrets: CISecretStore,
): Promise<GitHubSecretVerification[]> {
  const results: GitHubSecretVerification[] = []

  for (const secret of secrets) {
    if (!secret.environments.includes(env)) continue
    if (!secret.onePassword) continue

    const targets = getGitHubTargets(secret)
    if (targets.length === 0) continue

    const opField = resolveOpField(secret.onePassword.field, env)
    const opValue = await readOpField(secret.onePassword.itemId, opField)
    const opFp = computeFingerprint(opValue)

    for (const target of targets) {
      const ghFp = await ciSecrets.getFingerprint(target.owner, target.repo, target.secretName)

      let status: GitHubSecretVerification['status']
      if (ghFp === null) {
        status = 'unverified'
      } else if (ghFp === opFp) {
        status = 'ok'
      } else {
        status = 'mismatch'
      }

      results.push({
        secretName: target.secretName,
        repo: `${target.owner}/${target.repo}`,
        status,
        opFingerprint: opFp,
        githubFingerprint: ghFp,
      })
    }
  }

  return results
}
