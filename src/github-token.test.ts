import { describe, it, expect, vi } from 'vitest'
import { resolveGitHubToken } from './github-token.js'

describe('resolveGitHubToken', () => {
  it('prefers GITHUB_TOKEN from the environment', () => {
    const ghAuthToken = vi.fn()
    expect(resolveGitHubToken({ GITHUB_TOKEN: 'from-env' }, ghAuthToken)).toBe('from-env')
    expect(ghAuthToken).not.toHaveBeenCalled()
  })

  it('falls back to the gh CLI login', () => {
    expect(resolveGitHubToken({}, () => 'gho_from_gh\n')).toBe('gho_from_gh')
  })

  it('returns undefined when gh is missing or logged out', () => {
    expect(resolveGitHubToken({}, () => { throw new Error('gh: not logged in') })).toBeUndefined()
    expect(resolveGitHubToken({}, () => '   ')).toBeUndefined()
  })
})
