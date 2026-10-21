import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockQuery = vi.fn()
const mockConnect = vi.fn()
const mockEnd = vi.fn()

vi.mock('pg', () => ({
  default: {
    Client: vi.fn(() => ({
      connect: mockConnect,
      query: mockQuery,
      end: mockEnd,
    })),
  },
}))

import pg from 'pg'
import { PostgresIdpDatabaseWriter } from './idp-postgres.js'

describe('PostgresIdpDatabaseWriter', () => {
  let writer: PostgresIdpDatabaseWriter

  beforeEach(() => {
    vi.clearAllMocks()
    writer = new PostgresIdpDatabaseWriter()
  })

  it('updates OIDC client secret via SQL, preserving previous secret', async () => {
    mockQuery.mockResolvedValueOnce({ rowCount: 1 })

    await writer.updateOidcClientSecret(
      'postgresql://user:pw@host/db',
      'client-abc',
      'new-secret-xyz',
    )

    expect(pg.Client).toHaveBeenCalledWith({
      connectionString: 'postgresql://user:pw@host/db',
    })
    expect(mockConnect).toHaveBeenCalled()
    expect(mockQuery).toHaveBeenCalledWith(
      'UPDATE oidc_clients SET previous_client_secret = client_secret, client_secret = $1, updated_at = NOW() WHERE client_id = $2',
      ['new-secret-xyz', 'client-abc'],
    )
    expect(mockEnd).toHaveBeenCalled()
  })

  it('throws when OIDC client not found', async () => {
    mockQuery.mockResolvedValueOnce({ rowCount: 0 })

    await expect(
      writer.updateOidcClientSecret(
        'postgresql://user:pw@host/db',
        'missing-client',
        'secret',
      ),
    ).rejects.toThrow('oidc client not found: missing-client')

    expect(mockEnd).toHaveBeenCalled()
  })

  it('normalizes sslmode to verify-full', async () => {
    mockQuery.mockResolvedValueOnce({ rowCount: 1 })

    await writer.updateOidcClientSecret(
      'postgresql://user:pw@host/db?sslmode=require',
      'client-abc',
      'secret',
    )

    expect(pg.Client).toHaveBeenCalledWith({
      connectionString: 'postgresql://user:pw@host/db?sslmode=verify-full',
    })
  })

  it('normalizes sslmode=prefer to verify-full', async () => {
    mockQuery.mockResolvedValueOnce({ rowCount: 1 })

    await writer.updateOidcClientSecret(
      'postgresql://user:pw@host/db?sslmode=prefer',
      'client-abc',
      'secret',
    )

    expect(pg.Client).toHaveBeenCalledWith({
      connectionString: 'postgresql://user:pw@host/db?sslmode=verify-full',
    })
  })

  it('normalizes sslmode=verify-ca to verify-full', async () => {
    mockQuery.mockResolvedValueOnce({ rowCount: 1 })

    await writer.updateOidcClientSecret(
      'postgresql://user:pw@host/db?sslmode=verify-ca',
      'client-abc',
      'secret',
    )

    expect(pg.Client).toHaveBeenCalledWith({
      connectionString: 'postgresql://user:pw@host/db?sslmode=verify-full',
    })
  })

  it('always calls client.end() even when query throws', async () => {
    mockQuery.mockRejectedValueOnce(new Error('connection lost'))

    await expect(
      writer.updateOidcClientSecret(
        'postgresql://user:pw@host/db',
        'client-abc',
        'secret',
      ),
    ).rejects.toThrow('connection lost')

    expect(mockEnd).toHaveBeenCalled()
  })

  describe('clearPreviousOidcClientSecret', () => {
    it('clears previous_client_secret via SQL', async () => {
      mockQuery.mockResolvedValueOnce({ rowCount: 1 })

      await writer.clearPreviousOidcClientSecret(
        'postgresql://user:pw@host/db',
        'client-abc',
      )

      expect(pg.Client).toHaveBeenCalledWith({
        connectionString: 'postgresql://user:pw@host/db',
      })
      expect(mockConnect).toHaveBeenCalled()
      expect(mockQuery).toHaveBeenCalledWith(
        'UPDATE oidc_clients SET previous_client_secret = NULL, updated_at = NOW() WHERE client_id = $1',
        ['client-abc'],
      )
      expect(mockEnd).toHaveBeenCalled()
    })

    it('throws when OIDC client not found', async () => {
      mockQuery.mockResolvedValueOnce({ rowCount: 0 })

      await expect(
        writer.clearPreviousOidcClientSecret(
          'postgresql://user:pw@host/db',
          'missing-client',
        ),
      ).rejects.toThrow('oidc client not found: missing-client')

      expect(mockEnd).toHaveBeenCalled()
    })

    it('always calls client.end() even when query throws', async () => {
      mockQuery.mockRejectedValueOnce(new Error('connection lost'))

      await expect(
        writer.clearPreviousOidcClientSecret(
          'postgresql://user:pw@host/db',
          'client-abc',
        ),
      ).rejects.toThrow('connection lost')

      expect(mockEnd).toHaveBeenCalled()
    })
  })
})
