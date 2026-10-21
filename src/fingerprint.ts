import { createHash } from 'node:crypto'

const FP_PREFIX = 'fp:'

export function computeFingerprint(value: string): string {
  const hash = createHash('sha256').update(value).digest('hex').slice(0, 16)
  return `${FP_PREFIX}${hash}`
}

export function extractFingerprint(comment: string | undefined): string | null {
  if (!comment || !comment.startsWith(FP_PREFIX)) return null
  return comment
}
