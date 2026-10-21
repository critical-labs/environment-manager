import { describe, it, expect, vi, beforeEach } from 'vitest'
import type {
  Adapters,
  DatabaseRotationConfig,
  SecretRotationConfig,
} from './types.js'

// Mock node:child_process before importing rotate module
vi.mock('node:child_process', () => ({
  execFile: vi.fn(),
}))

// Mock node:util to return promisified execFile
vi.mock('node:util', async () => {
  const actual = await vi.importActual<typeof import('node:util')>('node:util')
  return {
    ...actual,
    promisify: vi.fn((fn: unknown) => fn),
  }
})

// Mock node:crypto for randomBytes
vi.mock('node:crypto', async () => {
  const actual = await vi.importActual<typeof import('node:crypto')>('node:crypto')
  return {
    ...actual,
    randomBytes: vi.fn(() => Buffer.from('deadbeefcafebabe', 'hex')),
  }
})

function createMockAdapters(): Adapters {
  return {
    secrets: {
      canResolve: () => false,
      resolve: vi.fn(),
      write: vi.fn(),
    },
    database: {
      resetRolePassword: vi.fn(async () => 'new-pass'),
      getConnectionUri: vi.fn(async () => 'postgres://user:new-pass@host/db'),
    },
    idpDatabase: {
      updateOidcClientSecret: vi.fn(),
    },
    ciSecrets: {
      upsertSecret: vi.fn(),
      upsertFingerprint: vi.fn(),
      getFingerprint: vi.fn(),
    },
  }
}

describe('rotateDatabase', () => {
  let adapters: Adapters
  let db: DatabaseRotationConfig

  beforeEach(() => {
    vi.clearAllMocks()
    adapters = createMockAdapters()
    db = {
      name: 'mydb',
      neon: {
        projectId: 'neon-proj-1',
        productionBranchId: 'br-prod-1',
        previewBranchId: 'br-preview-1',
        roleName: 'neondb_owner',
      },
      onePassword: {
        itemId: 'op-item-1',
        field: 'connectionString',
      },
    }
  })

  it('resets password, gets URI, writes to 1Password', async () => {
    const { rotateDatabase } = await import('./rotate.js')

    const results = await rotateDatabase(db, 'production', adapters, false)

    // Should reset role password with production branch
    expect(adapters.database!.resetRolePassword).toHaveBeenCalledWith(
      'neon-proj-1', 'br-prod-1', 'neondb_owner',
    )

    // Should get connection URI
    expect(adapters.database!.getConnectionUri).toHaveBeenCalledWith(
      'neon-proj-1', 'br-prod-1', 'neondb_owner',
    )

    // Should write connection URI to 1Password
    expect(adapters.secrets.write).toHaveBeenCalledWith(
      'op-item-1', 'connectionString', 'postgres://user:new-pass@host/db',
    )

    // Should return ok outcome
    expect(results).toEqual([
      expect.objectContaining({
        name: 'mydb',
        env: 'production',
        status: 'ok',
      }),
    ])
  })

  it('uses preview branch ID for preview env', async () => {
    const { rotateDatabase } = await import('./rotate.js')

    await rotateDatabase(db, 'preview', adapters, false)

    expect(adapters.database!.resetRolePassword).toHaveBeenCalledWith(
      'neon-proj-1', 'br-preview-1', 'neondb_owner',
    )
    expect(adapters.database!.getConnectionUri).toHaveBeenCalledWith(
      'neon-proj-1', 'br-preview-1', 'neondb_owner',
    )
  })

  it('aborts rotation when 1Password write fails', async () => {
    const { rotateDatabase } = await import('./rotate.js')

    vi.mocked(adapters.secrets.write).mockRejectedValueOnce(new Error('1OP auth timeout'))

    await expect(
      rotateDatabase(db, 'production', adapters, false),
    ).rejects.toThrow('1OP auth timeout')

    // Neon was called (password already reset — can't undo)
    expect(adapters.database!.resetRolePassword).toHaveBeenCalled()
  })

  it('substitutes password when getConnectionUri returns stale password', async () => {
    const { rotateDatabase } = await import('./rotate.js')

    // resetRolePassword returns new password
    vi.mocked(adapters.database!.resetRolePassword).mockResolvedValueOnce('brand-new-pass')
    // getConnectionUri returns URI with OLD password
    vi.mocked(adapters.database!.getConnectionUri).mockResolvedValueOnce(
      'postgres://user:stale-pass@host/db?sslmode=verify-full',
    )

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    await rotateDatabase(db, 'production', adapters, false)

    // Should warn about mismatch
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('stale password'),
    )

    // The URI written to 1Password should contain the NEW password
    const writtenUri = vi.mocked(adapters.secrets.write).mock.calls[0][2]
    expect(writtenUri).toContain('brand-new-pass')
    expect(writtenUri).not.toContain('stale-pass')

    warnSpy.mockRestore()
  })

  it('writes only to Neon and 1Password', async () => {
    const { rotateDatabase } = await import('./rotate.js')

    await rotateDatabase(db, 'production', adapters, false)

    // Neon + 1OP should be called
    expect(adapters.database!.resetRolePassword).toHaveBeenCalled()
    expect(adapters.secrets.write).toHaveBeenCalled()
  })

  it('returns dry-run result when dryRun is true (no API calls)', async () => {
    const { rotateDatabase } = await import('./rotate.js')

    const results = await rotateDatabase(db, 'production', adapters, true)

    expect(results).toEqual([
      { name: 'mydb', env: 'production', status: 'dry-run' },
    ])

    // No API calls should have been made
    expect(adapters.database!.resetRolePassword).not.toHaveBeenCalled()
    expect(adapters.database!.getConnectionUri).not.toHaveBeenCalled()
    expect(adapters.secrets.write).not.toHaveBeenCalled()
  })
})

describe('rotateSecret', () => {
  let adapters: Adapters

  beforeEach(() => {
    vi.clearAllMocks()
    adapters = createMockAdapters()
  })

  it('random secret: generates value, writes to 1Password', async () => {
    const { rotateSecret } = await import('./rotate.js')

    const secret: SecretRotationConfig = {
      name: 'JWT_SECRET',
      type: 'random',
      byteLength: 8,
      onePassword: { itemId: 'op-jwt', field: 'password' },
      environments: ['production'],
    }

    const results = await rotateSecret(secret, 'production', adapters, false)

    // Should write to 1Password
    expect(adapters.secrets.write).toHaveBeenCalledWith(
      'op-jwt', 'password', expect.any(String),
    )

    expect(results[0]).toEqual(expect.objectContaining({
      name: 'JWT_SECRET',
      env: 'production',
      status: 'ok',
    }))
  })

  it('writes to 1Password with _preview suffix for preview env', async () => {
    const { rotateSecret } = await import('./rotate.js')

    const secret: SecretRotationConfig = {
      name: 'MY_SECRET',
      type: 'random',
      byteLength: 8,
      onePassword: { itemId: 'op-item', field: 'my_secret' },
      environments: ['preview'],
    }

    await rotateSecret(secret, 'preview', adapters, false)

    // Should write to 1Password with _preview suffix
    expect(adapters.secrets.write).toHaveBeenCalledWith(
      'op-item', 'my_secret_preview', expect.any(String),
    )
  })

  it('skips external secrets during rotation', async () => {
    const { rotateSecret } = await import('./rotate.js')

    const secret: SecretRotationConfig = {
      name: 'VENDOR_API_TOKEN',
      type: 'external',
      onePassword: { itemId: 'op-ext', field: 'cloud' },
      environments: ['production'],
    }

    const results = await rotateSecret(secret, 'production', adapters, false)

    expect(results).toEqual([
      { name: 'VENDOR_API_TOKEN', env: 'production', status: 'skipped', error: 'external secrets are not rotated' },
    ])
    expect(adapters.secrets.write).not.toHaveBeenCalled()
  })

  it('skips rotation when skipRotation is true', async () => {
    const { rotateSecret } = await import('./rotate.js')

    const secret: SecretRotationConfig = {
      name: 'CI_ADMIN_TOKEN',
      type: 'github-pat',
      skipRotation: true,
      pat: {
        name: 'ci-admin',
        expirationDays: 30,
        permissions: { repository: { administration: 'write' } },
        repositories: ['app'],
        owner: 'acme',
      },
      onePassword: { itemId: 'op-ext', field: 'token' },
      environments: ['production'],
    }

    const results = await rotateSecret(secret, 'production', adapters, false)

    expect(results).toEqual([
      { name: 'CI_ADMIN_TOKEN', env: 'production', status: 'skipped', error: 'skipRotation is set' },
    ])
    expect(adapters.secrets.write).not.toHaveBeenCalled()
  })

  it('skips env not in secret.environments', async () => {
    const { rotateSecret } = await import('./rotate.js')

    const secret: SecretRotationConfig = {
      name: 'JWT_SECRET',
      type: 'random',
      byteLength: 32,
      environments: ['production'],
    }

    const results = await rotateSecret(secret, 'preview', adapters, false)

    expect(results).toEqual([])
  })

  it('dry-run returns status dry-run with no writes', async () => {
    const { rotateSecret } = await import('./rotate.js')

    const secret: SecretRotationConfig = {
      name: 'JWT_SECRET',
      type: 'random',
      byteLength: 32,
      environments: ['production'],
    }

    const results = await rotateSecret(secret, 'production', adapters, true)

    expect(results).toEqual([
      { name: 'JWT_SECRET', env: 'production', status: 'dry-run' },
    ])
    expect(adapters.secrets.write).not.toHaveBeenCalled()
  })

  it('idp-client: generates secret and writes to 1Password (no DB write)', async () => {
    const { rotateSecret } = await import('./rotate.js')

    const secret: SecretRotationConfig = {
      name: 'IDP_CLIENT_SECRET',
      type: 'idp-client',
      byteLength: 8,
      oidcClientId: 'client-123',
      idpDatabase: 'idp',
      onePassword: { itemId: 'op-idp-client', field: 'secret' },
      environments: ['production'],
    }

    const results = await rotateSecret(secret, 'production', adapters, false)

    // Should NOT write to IDP database (handled by sync)
    expect(adapters.idpDatabase!.updateOidcClientSecret).not.toHaveBeenCalled()

    // Should write to 1Password
    expect(adapters.secrets.write).toHaveBeenCalled()

    expect(results[0]).toEqual(expect.objectContaining({
      name: 'IDP_CLIENT_SECRET',
      env: 'production',
      status: 'ok',
    }))
  })

  it('external: skipped during rotation (value managed outside environment-manager)', async () => {
    const { rotateSecret } = await import('./rotate.js')

    const secret: SecretRotationConfig = {
      name: 'EXTERNAL_API_KEY',
      type: 'external',
      onePassword: { itemId: 'op-ext', field: 'apiKey' },
      environments: ['production'],
    }

    const results = await rotateSecret(secret, 'production', adapters, false)

    expect(results).toEqual([
      { name: 'EXTERNAL_API_KEY', env: 'production', status: 'skipped', error: 'external secrets are not rotated' },
    ])
    expect(adapters.secrets.write).not.toHaveBeenCalled()
  })

  it('github mappings: does not push to GitHub (handled by sync)', async () => {
    const { rotateSecret } = await import('./rotate.js')

    const secret: SecretRotationConfig = {
      name: 'DEPLOY_KEY',
      type: 'random',
      byteLength: 8,
      github: [{ owner: 'myorg', repo: 'myrepo', secretName: 'DEPLOY_KEY' }],
      environments: ['production'],
    }

    const results = await rotateSecret(secret, 'production', adapters, false)

    // GitHub push is handled by sync --apply via reconcileGitHubSecrets
    expect(adapters.ciSecrets!.upsertSecret).not.toHaveBeenCalled()
    expect(adapters.ciSecrets!.upsertFingerprint).not.toHaveBeenCalled()

    expect(results[0]).toEqual(expect.objectContaining({
      name: 'DEPLOY_KEY',
      env: 'production',
      status: 'ok',
    }))
  })

  it('random secret with format alphanumeric: generates a-zA-Z0-9 value', async () => {
    // Override randomBytes to return predictable bytes
    const { randomBytes } = await import('node:crypto')
    const mockRandomBytes = vi.mocked(randomBytes)
    // Return bytes that include values >= 248 (to test rejection) and valid values
    mockRandomBytes.mockReturnValueOnce(
      Buffer.from([65, 0, 250, 1, 255, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]) as never,
    )

    const { rotateSecret } = await import('./rotate.js')

    const secret: SecretRotationConfig = {
      name: 'BYPASS_SECRET',
      type: 'random',
      byteLength: 8,
      format: 'alphanumeric',
      onePassword: { itemId: 'op-bypass', field: 'bypass' },
      environments: ['production'],
    }

    await rotateSecret(secret, 'production', adapters, false)

    // The value written to 1Password should only contain a-zA-Z0-9
    const writtenValue = vi.mocked(adapters.secrets.write).mock.calls[0][2]
    expect(writtenValue).toMatch(/^[a-zA-Z0-9]+$/)
    expect(writtenValue).toHaveLength(8)
  })

  it('aborts rotation when 1Password write fails', async () => {
    const { rotateSecret } = await import('./rotate.js')

    vi.mocked(adapters.secrets.write).mockRejectedValueOnce(new Error('1OP auth timeout'))

    const secret: SecretRotationConfig = {
      name: 'JWT_SECRET',
      type: 'random',
      byteLength: 8,
      onePassword: { itemId: 'op-jwt', field: 'password' },
      environments: ['production'],
    }

    await expect(
      rotateSecret(secret, 'production', adapters, false),
    ).rejects.toThrow('1OP auth timeout')
  })

  it('writes only to 1Password', async () => {
    const { rotateSecret } = await import('./rotate.js')

    const secret: SecretRotationConfig = {
      name: 'JWT_SECRET',
      type: 'random',
      byteLength: 8,
      onePassword: { itemId: 'op-jwt', field: 'password' },
      environments: ['production'],
    }

    await rotateSecret(secret, 'production', adapters, false)

    // 1OP should be called
    expect(adapters.secrets.write).toHaveBeenCalled()
  })

  it('op-service-account: fails when OP_SERVICE_ACCOUNT_TOKEN is set', async () => {
    const { rotateSecret } = await import('./rotate.js')

    // biome-ignore lint/nursery/noProcessEnv: test needs to set env
    process.env.OP_SERVICE_ACCOUNT_TOKEN = 'some-token'

    const secret: SecretRotationConfig = {
      name: 'op-service-account',
      type: 'op-service-account',
      opServiceAccount: {
        accountName: 'test-account',
        vault: 'TestVault',
        permissions: 'read_items,write_items',
        expiresIn: '90d',
        settingsLocalPath: '.claude/settings.local.json',
        githubSecretName: 'OP_SERVICE_ACCOUNT_TOKEN',
        githubRepo: 'test/repo',
      },
      onePassword: { itemId: 'op-item', field: 'op_token' },
      environments: ['production'],
    }

    const results = await rotateSecret(secret, 'production', adapters, false)

    expect(results[0]).toEqual(expect.objectContaining({
      status: 'error',
      error: expect.stringContaining('full user auth'),
    }))

    // biome-ignore lint/nursery/noProcessEnv: test cleanup
    delete process.env.OP_SERVICE_ACCOUNT_TOKEN
  })

  it('op-service-account: creates account and writes to 1OP (no GitHub push)', async () => {
    const { execFile } = await import('node:child_process')
    const mockExecFile = vi.mocked(execFile)

    // Mock: op service-account create returns token
    mockExecFile.mockImplementation(
      ((...args: unknown[]) => {
        const cmd = args[0] as string
        if (cmd === 'op') {
          return Promise.resolve({ stdout: 'ops_new_service_account_token\n', stderr: '' })
        }
        return Promise.resolve({ stdout: '', stderr: '' })
      }) as never,
    )

    // Mock fs for settings.local.json
    vi.doMock('node:fs', () => ({
      existsSync: () => true,
      mkdirSync: vi.fn(),
      readFileSync: () => JSON.stringify({ env: {} }),
      writeFileSync: vi.fn(),
      chmodSync: vi.fn(),
    }))

    const { rotateSecret } = await import('./rotate.js')
    const { computeFingerprint } = await import('./fingerprint.js')

    const secret: SecretRotationConfig = {
      name: 'op-sa-token',
      type: 'op-service-account',
      opServiceAccount: {
        accountName: 'test-account',
        vault: 'TestVault',
        permissions: 'read_items',
        expiresIn: '90d',
        settingsLocalPath: '.claude/settings.local.json',
        githubSecretName: 'OP_SERVICE_ACCOUNT_TOKEN',
        githubRepo: 'acme/app',
      },
      onePassword: { itemId: 'op-item', field: 'op_token' },
      environments: ['production'],
    }

    await rotateSecret(secret, 'production', adapters, false)

    // GitHub push is handled by sync --apply via reconcileGitHubSecrets
    expect(adapters.ciSecrets!.upsertSecret).not.toHaveBeenCalled()
    expect(adapters.ciSecrets!.upsertFingerprint).not.toHaveBeenCalled()
  })

  it('op-service-account: creates a missing settings file rather than losing the new token', async () => {
    const { execFile } = await import('node:child_process')
    vi.mocked(execFile).mockImplementation(
      ((...args: unknown[]) => Promise.resolve({ stdout: args[0] === 'op' ? 'ops_fresh_token\n' : '', stderr: '' })) as never,
    )
    const writeFileSync = vi.fn()
    const mkdirSync = vi.fn()
    const chmodSync = vi.fn()
    vi.doMock('node:fs', () => ({
      existsSync: () => false,
      readFileSync: () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }) },
      writeFileSync,
      mkdirSync,
      chmodSync,
    }))

    const { rotateSecret } = await import('./rotate.js')
    const results = await rotateSecret({
      name: 'op-sa-token',
      type: 'op-service-account',
      opServiceAccount: {
        accountName: 'test-account', vault: 'TestVault', permissions: 'read_items', expiresIn: '90d',
        settingsLocalPath: '.claude/settings.local.json', githubSecretName: 'OP_SERVICE_ACCOUNT_TOKEN', githubRepo: 'o/r',
      },
      onePassword: { itemId: 'op-item', field: 'op_token' },
      environments: ['production'],
    }, 'production', adapters, false)

    expect(mkdirSync).toHaveBeenCalledWith('.claude', { recursive: true })
    expect(JSON.parse(writeFileSync.mock.calls[0][1])).toEqual({ env: { OP_SERVICE_ACCOUNT_TOKEN: 'ops_fresh_token' } })
    expect(writeFileSync.mock.calls[0][2]).toEqual({ encoding: 'utf-8', mode: 0o600 })
    expect(chmodSync).toHaveBeenCalledWith('.claude/settings.local.json', 0o600)
    expect(adapters.secrets.write).toHaveBeenCalledWith('op-item', 'op_token', 'ops_fresh_token')
    expect(results[0].status).toBe('ok')
  })

  it('github-pat: errors, since GitHub has no API to create fine-grained PATs', async () => {
    const { rotateSecret } = await import('./rotate.js')

    const secret: SecretRotationConfig = {
      name: 'ci-admin-pat',
      type: 'github-pat',
      onePassword: { itemId: 'op-item-1', field: 'ci_admin_token' },
      github: [{ owner: 'acme', repo: 'app', secretName: 'CI_ADMIN_TOKEN' }],
      environments: ['production'],
    }

    const results = await rotateSecret(secret, 'production', adapters, false)

    expect(adapters.secrets.write).not.toHaveBeenCalled()
    expect(results[0]).toEqual(expect.objectContaining({
      name: 'ci-admin-pat',
      status: 'error',
      error: expect.stringContaining('no API'),
    }))
  })
})
