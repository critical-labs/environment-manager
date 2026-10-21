import { describe, it, expect, vi } from 'vitest'
import { reconcileOidcClients, type SecretReader } from './reconcile-oidc.js'
import type { Adapters, RotationConfig, DatabaseProvider, IdpDatabaseWriter } from './types.js'

function makeRotationConfig(overrides?: Partial<RotationConfig>): RotationConfig {
  return {
    databases: [
      {
        name: 'auth',
        neon: {
          projectId: 'neon-proj-1',
          productionBranchId: 'br-prod',
          previewBranchId: 'br-preview',
          roleName: 'neondb_owner',
        },
        onePassword: { itemId: 'op-item-1', field: 'auth_database_url' },
      },
    ],
    secrets: [
      {
        name: 'app-client-secret-preview',
        type: 'idp-client',
        byteLength: 32,
        oidcClientId: 'web-app',
        idpDatabase: 'auth',
        onePassword: { itemId: 'op-item-2', field: 'app_client_secret' },
        environments: ['preview'],
      },
    ],
    ...overrides,
  }
}

function makeAdapters(opts: {
  dbSecret?: string | null
  connectionUri?: string
} = {}): Adapters {
  const database: DatabaseProvider = {
    resetRolePassword: vi.fn(),
    getConnectionUri: vi.fn(async () => opts.connectionUri ?? 'postgres://user:pass@host/db'),
  }
  const idpDatabase: IdpDatabaseWriter = {
    readOidcClientSecret: vi.fn(async () => opts.dbSecret !== undefined ? opts.dbSecret : 'old-secret'),
    updateOidcClientSecret: vi.fn(),
    clearPreviousOidcClientSecret: vi.fn(),
  }
  return {
    secrets: {
      canResolve: () => false,
      resolve: vi.fn(),
      write: vi.fn(),
    },
    database,
    idpDatabase,
  }
}

function mockReadSecret(value: string): SecretReader {
  return vi.fn(async () => value)
}

describe('reconcileOidcClients', () => {
  it('returns empty array when no idp-client secrets match the environment', async () => {
    const config = makeRotationConfig()
    const adapters = makeAdapters()
    const reader = mockReadSecret('secret')

    const results = await reconcileOidcClients(config, 'production', adapters, reader)

    expect(results).toEqual([])
  })

  it('reports ok when DB secret matches 1Password value', async () => {
    const reader = mockReadSecret('current-secret')
    const adapters = makeAdapters({ dbSecret: 'current-secret' })
    const config = makeRotationConfig()

    const results = await reconcileOidcClients(config, 'preview', adapters, reader)

    expect(results).toHaveLength(1)
    expect(results[0].status).toBe('ok')
    expect(results[0].clientId).toBe('web-app')
    expect(adapters.idpDatabase!.updateOidcClientSecret).not.toHaveBeenCalled()
  })

  it('updates DB when secret differs from 1Password value', async () => {
    const reader = mockReadSecret('new-rotated-secret')
    const adapters = makeAdapters({ dbSecret: 'old-stale-secret' })
    const config = makeRotationConfig()

    const results = await reconcileOidcClients(config, 'preview', adapters, reader)

    expect(results).toHaveLength(1)
    expect(results[0].status).toBe('updated')
    expect(adapters.idpDatabase!.updateOidcClientSecret).toHaveBeenCalledWith(
      'postgres://user:pass@host/db',
      'web-app',
      'new-rotated-secret',
    )
  })

  it('reports not-found when client is missing from DB', async () => {
    const reader = mockReadSecret('some-secret')
    const adapters = makeAdapters({ dbSecret: null })
    const config = makeRotationConfig()

    const results = await reconcileOidcClients(config, 'preview', adapters, reader)

    expect(results).toHaveLength(1)
    expect(results[0].status).toBe('not-found')
    expect(results[0].error).toContain('not found in database')
  })

  it('reports error when database config not found in rotation.yaml', async () => {
    const config = makeRotationConfig({ databases: [] })
    const adapters = makeAdapters()
    const reader = mockReadSecret('secret')

    const results = await reconcileOidcClients(config, 'preview', adapters, reader)

    expect(results).toHaveLength(1)
    expect(results[0].status).toBe('error')
    expect(results[0].error).toContain('database config "auth" not found')
  })

  it('reports error when onePassword config is missing', async () => {
    const config = makeRotationConfig()
    config.secrets[0].onePassword = undefined
    const adapters = makeAdapters()
    const reader = mockReadSecret('secret')

    const results = await reconcileOidcClients(config, 'preview', adapters, reader)

    expect(results).toHaveLength(1)
    expect(results[0].status).toBe('error')
    expect(results[0].error).toContain('no onePassword config')
  })

  it('skips when database adapters are not available', async () => {
    const config = makeRotationConfig()
    const adapters: Adapters = {
      secrets: { canResolve: () => false, resolve: vi.fn(), write: vi.fn() },
    }
    const reader = mockReadSecret('secret')

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const results = await reconcileOidcClients(config, 'preview', adapters, reader)
    warnSpy.mockRestore()

    expect(results).toEqual([])
  })

  it('uses preview branch when env is preview', async () => {
    const reader = mockReadSecret('secret')
    const adapters = makeAdapters({ dbSecret: 'secret' })
    const config = makeRotationConfig()

    await reconcileOidcClients(config, 'preview', adapters, reader)

    expect(adapters.database!.getConnectionUri).toHaveBeenCalledWith(
      'neon-proj-1', 'br-preview', 'neondb_owner',
    )
  })

  it('uses production branch when env is production', async () => {
    const reader = mockReadSecret('secret')
    const config = makeRotationConfig()
    config.secrets[0].environments = ['production']
    const adapters = makeAdapters({ dbSecret: 'secret' })

    await reconcileOidcClients(config, 'production', adapters, reader)

    expect(adapters.database!.getConnectionUri).toHaveBeenCalledWith(
      'neon-proj-1', 'br-prod', 'neondb_owner',
    )
  })

  it('appends _preview to 1Password field for preview env', async () => {
    const reader: SecretReader = vi.fn(async () => 'secret')
    const adapters = makeAdapters({ dbSecret: 'secret' })
    const config = makeRotationConfig()

    await reconcileOidcClients(config, 'preview', adapters, reader)

    expect(reader).toHaveBeenCalledWith('op-item-2', 'app_client_secret_preview')
  })

  it('uses base field name for production env', async () => {
    const reader: SecretReader = vi.fn(async () => 'secret')
    const config = makeRotationConfig()
    config.secrets[0].environments = ['production']
    const adapters = makeAdapters({ dbSecret: 'secret' })

    await reconcileOidcClients(config, 'production', adapters, reader)

    expect(reader).toHaveBeenCalledWith('op-item-2', 'app_client_secret')
  })

  it('reports error when readSecret fails', async () => {
    const reader: SecretReader = vi.fn(async () => { throw new Error('op not found') })
    const adapters = makeAdapters()
    const config = makeRotationConfig()

    const results = await reconcileOidcClients(config, 'preview', adapters, reader)

    expect(results).toHaveLength(1)
    expect(results[0].status).toBe('error')
    expect(results[0].error).toContain('failed to resolve 1Password value')
  })

  it('reports error when getConnectionUri fails', async () => {
    const reader = mockReadSecret('secret')
    const adapters = makeAdapters()
    vi.mocked(adapters.database!.getConnectionUri).mockRejectedValue(new Error('neon api down'))
    const config = makeRotationConfig()

    const results = await reconcileOidcClients(config, 'preview', adapters, reader)

    expect(results).toHaveLength(1)
    expect(results[0].status).toBe('error')
    expect(results[0].error).toContain('failed to get DB connection URI')
  })
})
