import pg from 'pg'
import type { IdpDatabaseWriter } from '../types.js'

function normalizeSslMode(uri: string): string {
  return uri.replace(/sslmode=(prefer|require|verify-ca)/, 'sslmode=verify-full')
}

export class PostgresIdpDatabaseWriter implements IdpDatabaseWriter {
  async readOidcClientSecret(connectionUri: string, oidcClientId: string): Promise<string | null> {
    const client = new pg.Client({ connectionString: normalizeSslMode(connectionUri) })
    await client.connect()
    try {
      const result = await client.query(
        'SELECT client_secret FROM oidc_clients WHERE client_id = $1',
        [oidcClientId],
      )
      if (result.rows.length === 0) return null
      return result.rows[0].client_secret
    } finally {
      await client.end()
    }
  }

  async updateOidcClientSecret(connectionUri: string, oidcClientId: string, newSecret: string): Promise<void> {
    const client = new pg.Client({ connectionString: normalizeSslMode(connectionUri) })
    await client.connect()
    try {
      const result = await client.query(
        'UPDATE oidc_clients SET previous_client_secret = client_secret, client_secret = $1, updated_at = NOW() WHERE client_id = $2',
        [newSecret, oidcClientId],
      )
      if (result.rowCount === 0) {
        throw new Error(`oidc client not found: ${oidcClientId}`)
      }
    } finally {
      await client.end()
    }
  }

  async clearPreviousOidcClientSecret(connectionUri: string, oidcClientId: string): Promise<void> {
    const client = new pg.Client({ connectionString: normalizeSslMode(connectionUri) })
    await client.connect()
    try {
      const result = await client.query(
        'UPDATE oidc_clients SET previous_client_secret = NULL, updated_at = NOW() WHERE client_id = $1',
        [oidcClientId],
      )
      if (result.rowCount === 0) {
        throw new Error(`oidc client not found: ${oidcClientId}`)
      }
    } finally {
      await client.end()
    }
  }
}
