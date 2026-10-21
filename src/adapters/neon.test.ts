import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { NeonDatabaseProvider } from './neon.js'

function okJson(body: unknown) {
  return { ok: true, status: 200, json: async () => body }
}

function errJson(status: number, message: string) {
  return { ok: false, status, json: async () => ({ message }) }
}

describe('NeonDatabaseProvider', () => {
  let provider: NeonDatabaseProvider
  let mockFetch: ReturnType<typeof vi.fn>

  beforeEach(() => {
    mockFetch = vi.fn()
    vi.stubGlobal('fetch', mockFetch)
    provider = new NeonDatabaseProvider('neon-api-key')
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  describe('resetRolePassword', () => {
    it('POSTs to Neon API and returns the new password', async () => {
      mockFetch.mockResolvedValueOnce(okJson({
        role: { password: 'new-password-123' },
      }))

      const result = await provider.resetRolePassword('proj_1', 'br_main', 'neondb_owner')

      expect(mockFetch).toHaveBeenCalledWith(
        'https://console.neon.tech/api/v2/projects/proj_1/branches/br_main/roles/neondb_owner/reset_password',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            Authorization: 'Bearer neon-api-key',
            'Content-Type': 'application/json',
          }),
        }),
      )

      expect(result).toBe('new-password-123')
    })

    it('throws on API error', async () => {
      mockFetch.mockResolvedValueOnce(errJson(403, 'Forbidden'))

      await expect(
        provider.resetRolePassword('proj_1', 'br_main', 'neondb_owner'),
      ).rejects.toThrow('Neon API error (403): Forbidden')
    })
  })

  describe('getConnectionUri', () => {
    it('GETs connection URI with correct query params', async () => {
      mockFetch.mockResolvedValueOnce(okJson({
        uri: 'postgresql://neondb_owner:pw@host.neon.tech/neondb',
      }))

      const result = await provider.getConnectionUri('proj_1', 'br_main', 'neondb_owner')

      expect(mockFetch).toHaveBeenCalledWith(
        'https://console.neon.tech/api/v2/projects/proj_1/connection_uri?branch_id=br_main&role_name=neondb_owner&database_name=neondb&pooled=false',
        expect.objectContaining({
          method: 'GET',
          headers: expect.objectContaining({
            Authorization: 'Bearer neon-api-key',
            'Content-Type': 'application/json',
          }),
        }),
      )

      expect(result).toBe('postgresql://neondb_owner:pw@host.neon.tech/neondb')
    })

    it('throws on API error', async () => {
      mockFetch.mockResolvedValueOnce(errJson(404, 'Project not found'))

      await expect(
        provider.getConnectionUri('proj_1', 'br_main', 'neondb_owner'),
      ).rejects.toThrow('Neon API error (404): Project not found')
    })
  })
})
