import type { RotationConfig } from './types.js'

/**
 * Validates a rotation config's toolEnv entries: each needs a value, and an
 * op:// URI needs at least vault/item/field.
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
      if (value.startsWith('op://')) {
        const segments = value.replace('op://', '').split('/')
        if (segments.length < 3) {
          errors.push(`toolEnv "${key}" op:// URI should have at least 3 path segments (vault/item/field), got ${segments.length}`)
        }
      }
    }
  }

  return errors
}
