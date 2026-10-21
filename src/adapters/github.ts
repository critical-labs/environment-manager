import { createRequire } from 'node:module'
import type { CISecretStore } from '../types.js'

const require = createRequire(import.meta.url)
const sodium = require('libsodium-wrappers')

const GITHUB_API = 'https://api.github.com'

export class GitHubCISecretStore implements CISecretStore {
  constructor(private token: string) {}

  private headers() {
    return {
      Authorization: `Bearer ${this.token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
    }
  }

  private async requestRaw(url: string, method: string, body?: unknown): Promise<Response> {
    return fetch(url, {
      method,
      headers: this.headers(),
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    })
  }

  private async request(url: string, method: string, body?: unknown): Promise<Response> {
    const res = await this.requestRaw(url, method, body)
    if (!res.ok) {
      const parsed = await res.json().catch(() => ({}))
      throw new Error(`GitHub API ${res.status}: ${(parsed as any).message ?? 'unknown error'}`)
    }
    return res
  }

  async upsertSecret(owner: string, repo: string, secretName: string, value: string): Promise<void> {
    const keyRes = await this.request(
      `${GITHUB_API}/repos/${owner}/${repo}/actions/secrets/public-key`, 'GET',
    )
    const { key, key_id } = await keyRes.json()

    await sodium.ready
    const publicKey = sodium.from_base64(key, sodium.base64_variants.ORIGINAL)
    const msg = sodium.from_string(value.trim())
    const encrypted = sodium.crypto_box_seal(msg, publicKey)
    const encryptedValue = sodium.to_base64(encrypted, sodium.base64_variants.ORIGINAL)

    await this.request(
      `${GITHUB_API}/repos/${owner}/${repo}/actions/secrets/${secretName}`,
      'PUT',
      { encrypted_value: encryptedValue, key_id },
    )
  }

  async upsertFingerprint(owner: string, repo: string, secretName: string, fingerprint: string): Promise<void> {
    const varName = `${secretName}__FINGERPRINT`
    const patchRes = await this.requestRaw(
      `${GITHUB_API}/repos/${owner}/${repo}/actions/variables/${varName}`,
      'PATCH',
      { value: fingerprint },
    )

    if (patchRes.ok) return

    if (patchRes.status === 404) {
      await this.request(
        `${GITHUB_API}/repos/${owner}/${repo}/actions/variables`,
        'POST',
        { name: varName, value: fingerprint },
      )
      return
    }

    const parsed = await patchRes.json().catch(() => ({}))
    throw new Error(`GitHub API ${patchRes.status}: ${(parsed as any).message ?? 'unknown error'}`)
  }

  async getFingerprint(owner: string, repo: string, secretName: string): Promise<string | null> {
    const varName = `${secretName}__FINGERPRINT`
    const res = await this.requestRaw(
      `${GITHUB_API}/repos/${owner}/${repo}/actions/variables/${varName}`,
      'GET',
    )

    if (res.status === 404) return null

    if (!res.ok) {
      const parsed = await res.json().catch(() => ({}))
      throw new Error(`GitHub API ${res.status}: ${(parsed as any).message ?? 'unknown error'}`)
    }

    const data = await res.json()
    return (data as any).value
  }
}
