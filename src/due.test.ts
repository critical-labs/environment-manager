import { describe, it, expect } from 'vitest'
import { selectDue } from './due.js'

const DAY = 24 * 60 * 60 * 1000
const NOW = new Date('2026-10-21T12:00:00Z')

function ago(days: number): string {
  return new Date(NOW.getTime() - days * DAY).toISOString()
}

describe('selectDue', () => {
  it('skips items without a rotation interval', () => {
    const items = [{ name: 'a' }]
    expect(selectDue(items, { lastRotated: {} }, NOW)).toEqual([])
  })

  it('treats an item never rotated as due', () => {
    const items = [{ name: 'a', rotationIntervalDays: 80 }]
    expect(selectDue(items, { lastRotated: {} }, NOW)).toEqual(items)
  })

  it('is due once the interval has elapsed, and not before', () => {
    const items = [
      { name: 'fresh', rotationIntervalDays: 80 },
      { name: 'exact', rotationIntervalDays: 80 },
      { name: 'stale', rotationIntervalDays: 80 },
    ]
    const state = { lastRotated: { fresh: ago(79), exact: ago(80), stale: ago(120) } }
    expect(selectDue(items, state, NOW).map((i) => i.name)).toEqual(['exact', 'stale'])
  })

  it('treats an unparseable timestamp as never rotated', () => {
    const items = [{ name: 'a', rotationIntervalDays: 80 }]
    expect(selectDue(items, { lastRotated: { a: 'not a date' } }, NOW)).toEqual(items)
  })
})
