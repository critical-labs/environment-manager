import { execFile } from 'node:child_process'

/** Post a desktop notification on macOS; a no-op elsewhere. Never throws. */
export function notify(title: string, message: string): Promise<void> {
  if (process.platform !== 'darwin') return Promise.resolve()
  const script = `display notification ${JSON.stringify(message)} with title ${JSON.stringify(title)}`
  return new Promise((resolve) => {
    execFile('osascript', ['-e', script], () => resolve())
  })
}
