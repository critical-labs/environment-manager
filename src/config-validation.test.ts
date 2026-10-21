import { describe, it, expect } from 'vitest'
import { validateRotationConfig } from './config-validation.js'
import type { RotationConfig } from './types.js'

describe('validateRotationConfig — toolEnv', () => {
  it('returns no errors when toolEnv values are valid', () => {
    const config: RotationConfig = {
      toolEnv: {
        NEON_API_KEY: 'op://Vault/item/field',
        GITHUB_TOKEN: 'op://Vault/item2/field2',
      },
      databases: [],
      secrets: [],
    }

    expect(validateRotationConfig(config)).toEqual([])
  })

  it('returns error when a toolEnv value is empty', () => {
    const config: RotationConfig = {
      toolEnv: { NEON_API_KEY: '' },
      databases: [],
      secrets: [],
    }

    const errors = validateRotationConfig(config)
    expect(errors).toHaveLength(1)
    expect(errors[0]).toContain('NEON_API_KEY')
    expect(errors[0]).toContain('empty')
  })

  it('warns when op:// URI has fewer than 3 path segments', () => {
    const config: RotationConfig = {
      toolEnv: { NEON_API_KEY: 'op://Vault/item' },
      databases: [],
      secrets: [],
    }

    const errors = validateRotationConfig(config)
    expect(errors).toHaveLength(1)
    expect(errors[0]).toContain('NEON_API_KEY')
    expect(errors[0]).toContain('segment')
  })

  it('accepts non-op:// plain values without segment check', () => {
    const config: RotationConfig = {
      toolEnv: { SOME_VAR: 'plain-value' },
      databases: [],
      secrets: [],
    }

    expect(validateRotationConfig(config)).toEqual([])
  })
})
