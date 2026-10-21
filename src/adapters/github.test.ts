import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Mock libsodium-wrappers (loaded via createRequire in the implementation)
const mockSodium = {
  ready: Promise.resolve(),
  base64_variants: { ORIGINAL: 1 },
  from_base64: vi.fn((_key: string) => new Uint8Array(32)),
  from_string: vi.fn((value: string) => new TextEncoder().encode(value)),
  crypto_box_seal: vi.fn((_msg: Uint8Array, _publicKey: Uint8Array) => new Uint8Array(48)),
  to_base64: vi.fn((_encrypted: Uint8Array) => 'base64-encrypted-value'),
}

vi.mock('node:module', () => ({
  createRequire: () => (id: string) => {
    if (id === 'libsodium-wrappers') return mockSodium
    throw new Error(`Unexpected require: ${id}`)
  },
}))

// Dynamic import after mocks are set up
const { GitHubCISecretStore } = await import('./github.js')

function okJson(body: unknown) {
  return { ok: true, status: 200, json: async () => body }
}

function errJson(status: number, message: string) {
  return { ok: false, status, json: async () => ({ message }) }
}

describe('GitHubCISecretStore', () => {
  let store: InstanceType<typeof GitHubCISecretStore>
  let mockFetch: ReturnType<typeof vi.fn>

  beforeEach(() => {
    mockFetch = vi.fn()
    vi.stubGlobal('fetch', mockFetch)
    store = new GitHubCISecretStore('gh-token')
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  describe('upsertSecret', () => {
    it('fetches public key then upserts encrypted secret', async () => {
      // First call: GET public-key
      mockFetch.mockResolvedValueOnce(okJson({
        key: 'base64-public-key',
        key_id: 'key-id-123',
      }))
      // Second call: PUT secret
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 201,
        json: async () => ({}),
      })

      await store.upsertSecret('my-org', 'my-repo', 'MY_SECRET', 'secret-value')

      expect(mockFetch).toHaveBeenCalledTimes(2)

      // Check GET public-key call
      expect(mockFetch).toHaveBeenNthCalledWith(1,
        'https://api.github.com/repos/my-org/my-repo/actions/secrets/public-key',
        expect.objectContaining({
          method: 'GET',
          headers: expect.objectContaining({
            Authorization: 'Bearer gh-token',
            Accept: 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28',
          }),
        }),
      )

      // Check PUT secret call
      expect(mockFetch).toHaveBeenNthCalledWith(2,
        'https://api.github.com/repos/my-org/my-repo/actions/secrets/MY_SECRET',
        expect.objectContaining({
          method: 'PUT',
          headers: expect.objectContaining({
            Authorization: 'Bearer gh-token',
          }),
          body: JSON.stringify({
            encrypted_value: 'base64-encrypted-value',
            key_id: 'key-id-123',
          }),
        }),
      )

      // Verify sodium was called correctly
      expect(mockSodium.from_base64).toHaveBeenCalledWith(
        'base64-public-key',
        mockSodium.base64_variants.ORIGINAL,
      )
      expect(mockSodium.from_string).toHaveBeenCalledWith('secret-value')
      expect(mockSodium.crypto_box_seal).toHaveBeenCalled()
      expect(mockSodium.to_base64).toHaveBeenCalled()
    })

    it('throws on API error', async () => {
      mockFetch.mockResolvedValueOnce(errJson(403, 'Bad credentials'))

      await expect(
        store.upsertSecret('my-org', 'my-repo', 'MY_SECRET', 'secret-value'),
      ).rejects.toThrow('GitHub API 403: Bad credentials')
    })
  })

  describe('upsertFingerprint', () => {
    it('updates existing variable via PATCH', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 204,
        json: async () => ({}),
      })

      await store.upsertFingerprint('my-org', 'my-repo', 'MY_SECRET', 'fp:abc123def456')

      expect(mockFetch).toHaveBeenCalledTimes(1)
      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.github.com/repos/my-org/my-repo/actions/variables/MY_SECRET__FINGERPRINT',
        expect.objectContaining({
          method: 'PATCH',
          headers: expect.objectContaining({
            Authorization: 'Bearer gh-token',
          }),
          body: JSON.stringify({ value: 'fp:abc123def456' }),
        }),
      )
    })

    it('creates new variable via POST when PATCH returns 404', async () => {
      // PATCH returns 404
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 404,
        json: async () => ({ message: 'Not Found' }),
      })
      // POST succeeds
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 201,
        json: async () => ({}),
      })

      await store.upsertFingerprint('my-org', 'my-repo', 'MY_SECRET', 'fp:abc123def456')

      expect(mockFetch).toHaveBeenCalledTimes(2)
      expect(mockFetch).toHaveBeenNthCalledWith(2,
        'https://api.github.com/repos/my-org/my-repo/actions/variables',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({
            name: 'MY_SECRET__FINGERPRINT',
            value: 'fp:abc123def456',
          }),
        }),
      )
    })

    it('throws on non-404 PATCH error', async () => {
      mockFetch.mockResolvedValueOnce(errJson(403, 'Bad credentials'))

      await expect(
        store.upsertFingerprint('my-org', 'my-repo', 'MY_SECRET', 'fp:abc123'),
      ).rejects.toThrow('GitHub API 403: Bad credentials')
    })
  })

  describe('getFingerprint', () => {
    it('returns variable value when it exists', async () => {
      mockFetch.mockResolvedValueOnce(okJson({
        name: 'MY_SECRET__FINGERPRINT',
        value: 'fp:abc123def456',
      }))

      const result = await store.getFingerprint('my-org', 'my-repo', 'MY_SECRET')

      expect(result).toBe('fp:abc123def456')
      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.github.com/repos/my-org/my-repo/actions/variables/MY_SECRET__FINGERPRINT',
        expect.objectContaining({ method: 'GET' }),
      )
    })

    it('returns null when variable does not exist (404)', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 404,
        json: async () => ({ message: 'Not Found' }),
      })

      const result = await store.getFingerprint('my-org', 'my-repo', 'MY_SECRET')

      expect(result).toBeNull()
    })

    it('throws on non-404 error', async () => {
      mockFetch.mockResolvedValueOnce(errJson(500, 'Internal Server Error'))

      await expect(
        store.getFingerprint('my-org', 'my-repo', 'MY_SECRET'),
      ).rejects.toThrow('GitHub API 500: Internal Server Error')
    })
  })
})
