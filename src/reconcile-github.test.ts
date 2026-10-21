import { describe, it, expect, vi } from 'vitest'
import { reconcileGitHubSecrets, type SecretReader } from './reconcile-github.js'
import type { CISecretStore, SecretRotationConfig } from './types.js'
import { computeFingerprint } from './fingerprint.js'

function mockCiSecrets(): CISecretStore {
  return {
    upsertSecret: vi.fn(),
    upsertFingerprint: vi.fn(),
    getFingerprint: vi.fn(async () => null),
  }
}

function mockReadSecret(value: string): SecretReader {
  return vi.fn(async () => value)
}

describe('reconcileGitHubSecrets', () => {
  it('returns empty array when no secrets match the environment', async () => {
    const secrets: SecretRotationConfig[] = [{
      name: 'my-secret',
      type: 'random',
      github: [{ owner: 'org', repo: 'repo', secretName: 'MY_SECRET' }],
      onePassword: { itemId: 'op-1', field: 'secret' },
      environments: ['production'],
    }]
    const ciSecrets = mockCiSecrets()
    const reader = mockReadSecret('value')

    const results = await reconcileGitHubSecrets(secrets, 'preview', ciSecrets, reader)

    expect(results).toEqual([])
  })

  it('reports ok when fingerprints match', async () => {
    const reader = mockReadSecret('current-secret')
    const ciSecrets = mockCiSecrets()
    vi.mocked(ciSecrets.getFingerprint).mockResolvedValue(computeFingerprint('current-secret'))

    const secrets: SecretRotationConfig[] = [{
      name: 'my-secret',
      type: 'random',
      github: [{ owner: 'org', repo: 'repo', secretName: 'MY_SECRET' }],
      onePassword: { itemId: 'op-1', field: 'secret' },
      environments: ['preview'],
    }]

    const results = await reconcileGitHubSecrets(secrets, 'preview', ciSecrets, reader)

    expect(results).toHaveLength(1)
    expect(results[0].status).toBe('ok')
    expect(results[0].secretName).toBe('MY_SECRET')
    expect(ciSecrets.upsertSecret).not.toHaveBeenCalled()
  })

  it('updates GitHub when fingerprint does not match', async () => {
    const reader = mockReadSecret('new-rotated-secret')
    const ciSecrets = mockCiSecrets()
    vi.mocked(ciSecrets.getFingerprint).mockResolvedValue(computeFingerprint('old-secret'))

    const secrets: SecretRotationConfig[] = [{
      name: 'my-secret',
      type: 'random',
      github: [{ owner: 'org', repo: 'repo', secretName: 'MY_SECRET' }],
      onePassword: { itemId: 'op-1', field: 'secret' },
      environments: ['preview'],
    }]

    const results = await reconcileGitHubSecrets(secrets, 'preview', ciSecrets, reader)

    expect(results).toHaveLength(1)
    expect(results[0].status).toBe('updated')
    expect(ciSecrets.upsertSecret).toHaveBeenCalledWith('org', 'repo', 'MY_SECRET', 'new-rotated-secret')
    expect(ciSecrets.upsertFingerprint).toHaveBeenCalledWith(
      'org', 'repo', 'MY_SECRET', computeFingerprint('new-rotated-secret'),
    )
  })

  it('updates GitHub when no fingerprint exists (unverified)', async () => {
    const reader = mockReadSecret('secret-value')
    const ciSecrets = mockCiSecrets()
    vi.mocked(ciSecrets.getFingerprint).mockResolvedValue(null)

    const secrets: SecretRotationConfig[] = [{
      name: 'my-secret',
      type: 'random',
      github: [{ owner: 'org', repo: 'repo', secretName: 'MY_SECRET' }],
      onePassword: { itemId: 'op-1', field: 'secret' },
      environments: ['production'],
    }]

    const results = await reconcileGitHubSecrets(secrets, 'production', ciSecrets, reader)

    expect(results).toHaveLength(1)
    expect(results[0].status).toBe('updated')
    expect(ciSecrets.upsertSecret).toHaveBeenCalled()
    expect(ciSecrets.upsertFingerprint).toHaveBeenCalled()
  })

  it('skips secrets without onePassword config', async () => {
    const ciSecrets = mockCiSecrets()
    const reader = mockReadSecret('value')

    const secrets: SecretRotationConfig[] = [{
      name: 'no-op',
      type: 'random',
      github: [{ owner: 'org', repo: 'repo', secretName: 'NO_OP' }],
      environments: ['production'],
    }]

    const results = await reconcileGitHubSecrets(secrets, 'production', ciSecrets, reader)

    expect(results).toEqual([])
  })

  it('skips secrets without github targets', async () => {
    const ciSecrets = mockCiSecrets()
    const reader = mockReadSecret('value')

    const secrets: SecretRotationConfig[] = [{
      name: 'no-gh',
      type: 'random',
      onePassword: { itemId: 'op-1', field: 'secret' },
      environments: ['production'],
    }]

    const results = await reconcileGitHubSecrets(secrets, 'production', ciSecrets, reader)

    expect(results).toEqual([])
  })

  it('reports error when 1Password read fails', async () => {
    const reader: SecretReader = vi.fn(async () => { throw new Error('op not found') })
    const ciSecrets = mockCiSecrets()

    const secrets: SecretRotationConfig[] = [{
      name: 'my-secret',
      type: 'random',
      github: [{ owner: 'org', repo: 'repo', secretName: 'MY_SECRET' }],
      onePassword: { itemId: 'op-1', field: 'secret' },
      environments: ['production'],
    }]

    const results = await reconcileGitHubSecrets(secrets, 'production', ciSecrets, reader)

    expect(results).toHaveLength(1)
    expect(results[0].status).toBe('error')
    expect(results[0].error).toContain('failed to resolve 1Password value')
  })

  it('reports error when GitHub operation fails', async () => {
    const reader = mockReadSecret('value')
    const ciSecrets = mockCiSecrets()
    vi.mocked(ciSecrets.getFingerprint).mockRejectedValue(new Error('github api down'))

    const secrets: SecretRotationConfig[] = [{
      name: 'my-secret',
      type: 'random',
      github: [{ owner: 'org', repo: 'repo', secretName: 'MY_SECRET' }],
      onePassword: { itemId: 'op-1', field: 'secret' },
      environments: ['production'],
    }]

    const results = await reconcileGitHubSecrets(secrets, 'production', ciSecrets, reader)

    expect(results).toHaveLength(1)
    expect(results[0].status).toBe('error')
    expect(results[0].error).toContain('GitHub operation failed')
  })

  it('handles op-service-account github targets', async () => {
    const reader = mockReadSecret('sa-token')
    const ciSecrets = mockCiSecrets()
    vi.mocked(ciSecrets.getFingerprint).mockResolvedValue(null)

    const secrets: SecretRotationConfig[] = [{
      name: 'op-sa',
      type: 'op-service-account',
      opServiceAccount: {
        accountName: 'test',
        vault: 'V',
        permissions: 'read',
        expiresIn: '90d',
        settingsLocalPath: '.claude/settings.local.json',
        githubSecretName: 'OP_TOKEN',
        githubRepo: 'acme/app',
      },
      onePassword: { itemId: 'op-1', field: 'token' },
      environments: ['production'],
    }]

    const results = await reconcileGitHubSecrets(secrets, 'production', ciSecrets, reader)

    expect(results).toHaveLength(1)
    expect(results[0].status).toBe('updated')
    expect(ciSecrets.upsertSecret).toHaveBeenCalledWith('acme', 'app', 'OP_TOKEN', 'sa-token')
  })

  it('appends _preview to 1Password field for preview env', async () => {
    const reader: SecretReader = vi.fn(async () => 'value')
    const ciSecrets = mockCiSecrets()
    vi.mocked(ciSecrets.getFingerprint).mockResolvedValue(computeFingerprint('value'))

    const secrets: SecretRotationConfig[] = [{
      name: 'my-secret',
      type: 'random',
      github: [{ owner: 'org', repo: 'repo', secretName: 'MY_SECRET' }],
      onePassword: { itemId: 'op-1', field: 'secret' },
      environments: ['preview'],
    }]

    await reconcileGitHubSecrets(secrets, 'preview', ciSecrets, reader)

    expect(reader).toHaveBeenCalledWith('op-1', 'secret_preview')
  })
})
