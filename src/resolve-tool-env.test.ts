import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { resolveToolEnv } from './resolve-tool-env.js'
import type { SecretStore } from './types.js'

function mockSecretStore(resolveMap: Record<string, string> = {}): SecretStore {
  return {
    canResolve: (v: string) => v.startsWith('op://'),
    resolve: vi.fn(async (uri: string) => {
      const val = resolveMap[uri]
      if (!val) throw new Error(`not found: ${uri}`)
      return val
    }),
    write: vi.fn(),
  }
}

describe('resolveToolEnv', () => {
  const saved: Record<string, string | undefined> = {}

  beforeEach(() => {
    saved.NEON_API_KEY = process.env.NEON_API_KEY
    saved.NEON_API_KEY = process.env.NEON_API_KEY
    delete process.env.NEON_API_KEY
    delete process.env.NEON_API_KEY
  })

  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  })

  it('resolves op:// values and sets them in process.env', async () => {
    const store = mockSecretStore({ 'op://Vault/item/field': 'resolved-token' })
    await resolveToolEnv({ NEON_API_KEY: 'op://Vault/item/field' }, store)
    expect(process.env.NEON_API_KEY).toBe('resolved-token')
    expect(store.resolve).toHaveBeenCalledWith('op://Vault/item/field')
  })

  it('sets plain string values directly', async () => {
    const store = mockSecretStore()
    await resolveToolEnv({ NEON_API_KEY: 'plain-value' }, store)
    expect(process.env.NEON_API_KEY).toBe('plain-value')
    expect(store.resolve).not.toHaveBeenCalled()
  })

  it('does not overwrite existing process.env values', async () => {
    process.env.NEON_API_KEY = 'already-set'
    const store = mockSecretStore({ 'op://Vault/item/field': 'new-value' })
    await resolveToolEnv({ NEON_API_KEY: 'op://Vault/item/field' }, store)
    expect(process.env.NEON_API_KEY).toBe('already-set')
    expect(store.resolve).not.toHaveBeenCalled()
  })

  it('throws with a helpful message when op resolution fails', async () => {
    const store = mockSecretStore({})
    await expect(
      resolveToolEnv({ NEON_API_KEY: 'op://Vault/missing/field' }, store),
    ).rejects.toThrow(/NEON_API_KEY/)
  })

  it('is a no-op when toolEnv is undefined', async () => {
    const store = mockSecretStore()
    await resolveToolEnv(undefined, store)
    expect(store.resolve).not.toHaveBeenCalled()
  })
})
