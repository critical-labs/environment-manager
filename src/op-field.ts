/**
 * Resolve the 1Password field label for a secret in a given environment.
 *
 * Convention: production uses the base field name; preview appends `_preview`.
 * A configured field may already end in `_preview`, so guard against doubling it.
 */
export function resolveOpField(field: string, env: string): string {
  if (env === 'preview' && !field.endsWith('_preview')) {
    return `${field}_preview`
  }
  return field
}

/**
 * Read a field from a 1Password item.
 *
 * When a vault is known (the OP_VAULT environment variable, set directly or
 * from the `vault` key in rotation.yaml), uses `op read` with a constructed
 * op:// URI — more reliable than `op item get --fields`, which can return
 * extra formatting or hide concealed field values, and it preserves
 * section.field notation (e.g. "api.key" → "api/key").
 *
 * Without a vault, falls back to `op item get` by item ID, which is unique
 * across the account; section qualifiers are reduced to the bare field label.
 */
export async function readOpItemField(itemId: string, field: string): Promise<string> {
  const { execFile } = await import('node:child_process')
  const { promisify } = await import('node:util')
  const execFileAsync = promisify(execFile)
  const vault = process.env.OP_VAULT
  if (vault) {
    const pathSegments = field.split('.').join('/')
    const { stdout } = await execFileAsync('op', ['read', `op://${vault}/${itemId}/${pathSegments}`])
    return stdout.trim()
  }
  const label = field.includes('.') ? field.split('.').pop()! : field
  const { stdout } = await execFileAsync('op', ['item', 'get', itemId, '--fields', `label=${label}`, '--reveal'])
  return stdout.trim()
}
