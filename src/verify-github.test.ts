import { describe, it, expect, vi } from 'vitest'
import { computeFingerprint } from './fingerprint.js'
import type { CISecretStore, SecretRotationConfig, GitHubSecretVerification } from './types.js'

function mockCiSecrets(fingerprints: Record<string, string | null> = {}): CISecretStore {
  return {
    upsertSecret: vi.fn(),
    upsertFingerprint: vi.fn(),
    getFingerprint: vi.fn(async (_owner: string, _repo: string, secretName: string) => {
      const varName = secretName
      return fingerprints[varName] ?? null
    }),
  }
}

// Mock node:child_process for readOpField
vi.mock('node:child_process', () => ({
  execFile: vi.fn(),
}))

vi.mock('node:util', async () => {
  const actual = await vi.importActual<typeof import('node:util')>('node:util')
  return {
    ...actual,
    promisify: vi.fn((fn: unknown) => fn),
  }
})

describe('verifyGitHubSecrets', () => {
  it('returns ok when fingerprints match', async () => {
    const { execFile } = await import('node:child_process')
    vi.mocked(execFile).mockImplementation(
      ((..._args: unknown[]) => Promise.resolve({ stdout: 'my-secret-value\n', stderr: '' })) as never,
    )

    const { verifyGitHubSecrets } = await import('./verify-github.js')

    const secrets: SecretRotationConfig[] = [{
      name: 'test-secret',
      type: 'random',
      onePassword: { itemId: 'op-1', field: 'token' },
      github: [{ owner: 'myorg', repo: 'myrepo', secretName: 'MY_SECRET' }],
      environments: ['production'],
    }]

    const fp = computeFingerprint('my-secret-value')
    const ciSecrets = mockCiSecrets({ MY_SECRET: fp })

    const results = await verifyGitHubSecrets(secrets, 'production', ciSecrets)

    expect(results).toEqual([{
      secretName: 'MY_SECRET',
      repo: 'myorg/myrepo',
      status: 'ok',
      opFingerprint: fp,
      githubFingerprint: fp,
    }])
  })

  it('returns mismatch when fingerprints differ', async () => {
    const { execFile } = await import('node:child_process')
    vi.mocked(execFile).mockImplementation(
      ((..._args: unknown[]) => Promise.resolve({ stdout: 'new-value\n', stderr: '' })) as never,
    )

    const { verifyGitHubSecrets } = await import('./verify-github.js')

    const secrets: SecretRotationConfig[] = [{
      name: 'test-secret',
      type: 'random',
      onePassword: { itemId: 'op-1', field: 'token' },
      github: [{ owner: 'myorg', repo: 'myrepo', secretName: 'MY_SECRET' }],
      environments: ['production'],
    }]

    const staleGhFp = computeFingerprint('old-value')
    const ciSecrets = mockCiSecrets({ MY_SECRET: staleGhFp })

    const results = await verifyGitHubSecrets(secrets, 'production', ciSecrets)

    expect(results).toEqual([{
      secretName: 'MY_SECRET',
      repo: 'myorg/myrepo',
      status: 'mismatch',
      opFingerprint: computeFingerprint('new-value'),
      githubFingerprint: staleGhFp,
    }])
  })

  it('returns unverified when no fingerprint variable exists', async () => {
    const { execFile } = await import('node:child_process')
    vi.mocked(execFile).mockImplementation(
      ((..._args: unknown[]) => Promise.resolve({ stdout: 'some-value\n', stderr: '' })) as never,
    )

    const { verifyGitHubSecrets } = await import('./verify-github.js')

    const secrets: SecretRotationConfig[] = [{
      name: 'test-secret',
      type: 'random',
      onePassword: { itemId: 'op-1', field: 'token' },
      github: [{ owner: 'myorg', repo: 'myrepo', secretName: 'MY_SECRET' }],
      environments: ['production'],
    }]

    const ciSecrets = mockCiSecrets({})

    const results = await verifyGitHubSecrets(secrets, 'production', ciSecrets)

    expect(results).toEqual([{
      secretName: 'MY_SECRET',
      repo: 'myorg/myrepo',
      status: 'unverified',
      opFingerprint: computeFingerprint('some-value'),
      githubFingerprint: null,
    }])
  })

  it('skips secrets without github mappings', async () => {
    const { verifyGitHubSecrets } = await import('./verify-github.js')

    const secrets: SecretRotationConfig[] = [{
      name: 'no-github',
      type: 'random',
      onePassword: { itemId: 'op-1', field: 'token' },
      environments: ['production'],
    }]

    const ciSecrets = mockCiSecrets({})
    const results = await verifyGitHubSecrets(secrets, 'production', ciSecrets)

    expect(results).toEqual([])
  })

  it('skips secrets without onePassword config', async () => {
    const { verifyGitHubSecrets } = await import('./verify-github.js')

    const secrets: SecretRotationConfig[] = [{
      name: 'no-op',
      type: 'random',
      github: [{ owner: 'myorg', repo: 'myrepo', secretName: 'MY_SECRET' }],
      environments: ['production'],
    }]

    const ciSecrets = mockCiSecrets({})
    const results = await verifyGitHubSecrets(secrets, 'production', ciSecrets)

    expect(results).toEqual([])
  })

  it('skips secrets not in the target environment', async () => {
    const { verifyGitHubSecrets } = await import('./verify-github.js')

    const secrets: SecretRotationConfig[] = [{
      name: 'prod-only',
      type: 'random',
      onePassword: { itemId: 'op-1', field: 'token' },
      github: [{ owner: 'myorg', repo: 'myrepo', secretName: 'MY_SECRET' }],
      environments: ['production'],
    }]

    const ciSecrets = mockCiSecrets({})
    const results = await verifyGitHubSecrets(secrets, 'preview', ciSecrets)

    expect(results).toEqual([])
  })

  it('handles op-service-account secrets using opServiceAccount config', async () => {
    const { execFile } = await import('node:child_process')
    vi.mocked(execFile).mockImplementation(
      ((..._args: unknown[]) => Promise.resolve({ stdout: 'ops_token_value\n', stderr: '' })) as never,
    )

    const { verifyGitHubSecrets } = await import('./verify-github.js')

    const secrets: SecretRotationConfig[] = [{
      name: 'op-sa',
      type: 'op-service-account',
      opServiceAccount: {
        accountName: 'test',
        vault: 'V',
        permissions: 'read_items',
        expiresIn: '90d',
        settingsLocalPath: '.claude/settings.local.json',
        githubSecretName: 'OP_SERVICE_ACCOUNT_TOKEN',
        githubRepo: 'acme/app',
      },
      onePassword: { itemId: 'op-1', field: 'op_token' },
      environments: ['production'],
    }]

    const fp = computeFingerprint('ops_token_value')
    const ciSecrets = mockCiSecrets({ OP_SERVICE_ACCOUNT_TOKEN: fp })

    const results = await verifyGitHubSecrets(secrets, 'production', ciSecrets)

    expect(results).toEqual([{
      secretName: 'OP_SERVICE_ACCOUNT_TOKEN',
      repo: 'acme/app',
      status: 'ok',
      opFingerprint: fp,
      githubFingerprint: fp,
    }])
  })
})
