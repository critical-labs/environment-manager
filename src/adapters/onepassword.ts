import { execFile } from 'node:child_process'
import type { SecretStore } from '../types.js'

export class OnePasswordSecretStore implements SecretStore {
  canResolve(value: string): boolean {
    return value.startsWith('op://')
  }

  resolve(uri: string): Promise<string> {
    return new Promise((resolve, reject) => {
      execFile('op', ['read', uri], (err, stdout) => {
        if (err) {
          reject(new Error(`Failed to resolve 1Password reference ${uri}: ${err.message}`))
          return
        }
        resolve(stdout.trim())
      })
    })
  }

  write(itemId: string, field: string, value: string): Promise<void> {
    return new Promise((resolve, reject) => {
      execFile('op', ['item', 'edit', itemId, `${field}[concealed]=${value}`], (err, _stdout, stderr) => {
        if (err) {
          // err.message repeats the command line, and with it the new value;
          // report only what op itself printed.
          const detail = String(stderr ?? '').trim() || `op exited with ${err.code ?? 'an error'}`
          reject(new Error(`Failed to write field ${field} of 1Password item ${itemId}: ${detail}`))
          return
        }
        resolve()
      })
    })
  }
}
