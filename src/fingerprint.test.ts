import { describe, it, expect } from 'vitest'
import { computeFingerprint, extractFingerprint } from './fingerprint.js'

describe('computeFingerprint', () => {
  it('returns fp: prefix followed by 16 hex chars', () => {
    const result = computeFingerprint('my-secret-value')
    expect(result).toMatch(/^fp:[0-9a-f]{16}$/)
  })

  it('returns the same fingerprint for the same input', () => {
    const a = computeFingerprint('hello')
    const b = computeFingerprint('hello')
    expect(a).toBe(b)
  })

  it('returns different fingerprints for different inputs', () => {
    const a = computeFingerprint('secret-A')
    const b = computeFingerprint('secret-B')
    expect(a).not.toBe(b)
  })
})

describe('extractFingerprint', () => {
  it('returns fingerprint string when comment starts with fp:', () => {
    const result = extractFingerprint('fp:a1b2c3d4e5f6a7b8')
    expect(result).toBe('fp:a1b2c3d4e5f6a7b8')
  })

  it('returns null when comment is undefined', () => {
    expect(extractFingerprint(undefined)).toBeNull()
  })

  it('returns null when comment is empty', () => {
    expect(extractFingerprint('')).toBeNull()
  })

  it('returns null when comment does not start with fp:', () => {
    expect(extractFingerprint('some other comment')).toBeNull()
  })
})
