import type { RotationState } from './rotation-state.js'

const DAY_MS = 24 * 60 * 60 * 1000

/**
 * The items whose `rotationIntervalDays` has elapsed since their last
 * recorded rotation. Items without an interval are never due; items never
 * rotated (or with an unreadable timestamp) are due at once.
 */
export function selectDue<T extends { name: string; rotationIntervalDays?: number }>(
  items: T[],
  state: RotationState,
  now: Date = new Date(),
  keyOf: (item: T) => string = (item) => item.name,
): T[] {
  return items.filter((item) => {
    if (!item.rotationIntervalDays) return false
    const last = Date.parse(state.lastRotated[keyOf(item)] ?? '')
    if (Number.isNaN(last)) return true
    return (now.getTime() - last) / DAY_MS >= item.rotationIntervalDays
  })
}
