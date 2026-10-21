import type { RotationConfig } from './types.js'

/**
 * Validates a rotation config's toolEnv entries: each must be an op:// reference
 * with at least vault/item/field. A literal value would let a config change
 * supply its own credentials, such as a GitHub token for someone else's account.
 *
 * Returns an array of error strings (empty = valid).
 */
export function validateRotationConfig(config: RotationConfig): string[] {
  const errors: string[] = []

  // Validate toolEnv entries
  if (config.toolEnv) {
    for (const [key, value] of Object.entries(config.toolEnv)) {
      if (!value) {
        errors.push(`toolEnv "${key}" has an empty value`)
        continue
      }
      if (!value.startsWith('op://')) {
        errors.push(`toolEnv "${key}" must be an op:// reference, not a literal value`)
        continue
      }
      {
        const segments = value.replace('op://', '').split('/')
        if (segments.length < 3) {
          errors.push(`toolEnv "${key}" op:// URI should have at least 3 path segments (vault/item/field), got ${segments.length}`)
        }
      }
    }
  }

  return errors
}
