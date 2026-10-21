import type { SecretStore } from './types.js'

export async function resolveToolEnv(
  toolEnv: Record<string, string> | undefined,
  secrets: SecretStore,
): Promise<void> {
  if (!toolEnv) return

  for (const [key, value] of Object.entries(toolEnv)) {
    // biome-ignore lint/nursery/noProcessEnv: toolEnv bootstraps env vars before adapters
    if (process.env[key]) continue

    try {
      // biome-ignore lint/nursery/noProcessEnv: toolEnv bootstraps env vars before adapters
      process.env[key] = secrets.canResolve(value)
        ? await secrets.resolve(value)
        : value
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      throw new Error(
        `Failed to resolve toolEnv.${key}: ${msg}\nHint: Run \`op signin\` or set ${key} in your environment.`,
      )
    }
  }
}
