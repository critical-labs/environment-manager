import { execFileSync } from 'node:child_process'

function ghAuthToken(): string {
  return execFileSync('gh', ['auth', 'token'], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] })
}

/**
 * The GitHub token for the Actions secrets API: GITHUB_TOKEN when set (CI,
 * or rotation.yaml's toolEnv), otherwise the local `gh` CLI login.
 */
export function resolveGitHubToken(
  env: Record<string, string | undefined> = process.env,
  readGhToken: () => string = ghAuthToken,
): string | undefined {
  if (env.GITHUB_TOKEN) return env.GITHUB_TOKEN
  try {
    return readGhToken().trim() || undefined
  } catch {
    return undefined
  }
}
