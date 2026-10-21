import type { DatabaseProvider } from '../types.js'

const BASE_URL = 'https://console.neon.tech/api/v2'

export class NeonDatabaseProvider implements DatabaseProvider {
  constructor(private readonly apiKey: string) {}

  private headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.apiKey}`,
      'Content-Type': 'application/json',
    }
  }

  private async request(url: string, options: RequestInit = {}): Promise<unknown> {
    const res = await fetch(url, {
      ...options,
      headers: { ...this.headers(), ...(options.headers as Record<string, string> | undefined) },
    })
    const body = await res.json()
    if (!res.ok) {
      const message = (body as { message?: string })?.message ?? 'Unknown error'
      throw new Error(`Neon API error (${res.status}): ${message}`)
    }
    return body
  }

  async resetRolePassword(
    projectId: string,
    branchId: string,
    roleName: string,
  ): Promise<string> {
    const body = await this.request(
      `${BASE_URL}/projects/${projectId}/branches/${branchId}/roles/${roleName}/reset_password`,
      { method: 'POST' },
    ) as { role: { password: string } }

    return body.role.password
  }

  async getConnectionUri(
    projectId: string,
    branchId: string,
    roleName: string,
  ): Promise<string> {
    const params = new URLSearchParams({
      branch_id: branchId,
      role_name: roleName,
      database_name: 'neondb',
      pooled: 'false',
    })

    const body = await this.request(
      `${BASE_URL}/projects/${projectId}/connection_uri?${params.toString()}`,
      { method: 'GET' },
    ) as { uri: string }

    return body.uri
  }
}
