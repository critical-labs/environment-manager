import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { loadManifest, loadRotationConfig } from './manifest.js'

vi.mock('node:fs', () => ({
  readFileSync: vi.fn(),
}))

const mockedReadFile = vi.mocked(readFileSync)

describe('loadManifest', () => {
  it('parses a valid manifest YAML', () => {
    mockedReadFile.mockReturnValue(`
shared:
  JWT_SECRET: "op://Vault/item/field"
  COOKIE_DOMAIN: ".example.com"
projects:
  web:
    APP_URL: "https://app.example.com"
  api:
    DB_URL: "op://Vault/db/url"
`)
    const result = loadManifest('/root', 'server-prod')
    expect(result.shared).toEqual({
      JWT_SECRET: 'op://Vault/item/field',
      COOKIE_DOMAIN: '.example.com',
    })
    expect(result.projects['web']).toEqual({
      APP_URL: 'https://app.example.com',
    })
    expect(result.projects['api']).toEqual({
      DB_URL: 'op://Vault/db/url',
    })
    expect(mockedReadFile).toHaveBeenCalledWith(
      '/root/.environment-manager/server-prod.manifest.yaml',
      'utf-8',
    )
  })

  it('defaults to empty shared and projects when omitted', () => {
    mockedReadFile.mockReturnValue('{}')
    const result = loadManifest('/root', 'server-staging')
    expect(result.shared).toEqual({})
    expect(result.projects).toEqual({})
  })
})

describe('loadRotationConfig', () => {
  it('parses rotation.yaml', () => {
    mockedReadFile.mockReturnValue(`
databases:
  - name: auth
    neon:
      projectId: "proj-1"
      productionBranchId: "br-prod"
      previewBranchId: "br-prev"
      roleName: "owner"
    onePassword:
      itemId: "item-1"
      field: "db_url"
secrets:
  - name: session-secret
    type: random
    byteLength: 32
    environments: [production]
`)
    const result = loadRotationConfig('/root')
    expect(result.databases).toHaveLength(1)
    expect(result.databases[0].name).toBe('auth')
    expect(result.databases[0].neon.projectId).toBe('proj-1')
    expect(result.secrets).toHaveLength(1)
    expect(result.secrets[0].type).toBe('random')
  })

  it('defaults to empty arrays when omitted', () => {
    mockedReadFile.mockReturnValue('{}')
    const result = loadRotationConfig('/root')
    expect(result.databases).toEqual([])
    expect(result.secrets).toEqual([])
  })
})

describe('loadManifest with annotated values', () => {
  it('resolves object-form values to plain strings', () => {
    mockedReadFile.mockReturnValue(`
shared:
  JWT_SECRET: "op://Vault/item/field"
projects:
  web:
    WEB_URL: "https://web.example.com"
    USER_DATABASE_URL:
      value: "op://Vault/db/url"
      from: user-service
`)
    const result = loadManifest('/root', 'server-staging')
    expect(result.shared).toEqual({ JWT_SECRET: 'op://Vault/item/field' })
    expect(result.projects['web']).toEqual({
      WEB_URL: 'https://web.example.com',
      USER_DATABASE_URL: 'op://Vault/db/url',
    })
  })

  it('handles mixed plain and annotated values in shared', () => {
    mockedReadFile.mockReturnValue(`
shared:
  PLAIN: "plain-value"
  ANNOTATED:
    value: "annotated-value"
    from: some-service
projects: {}
`)
    const result = loadManifest('/root', 'server-staging')
    expect(result.shared).toEqual({
      PLAIN: 'plain-value',
      ANNOTATED: 'annotated-value',
    })
  })
})
