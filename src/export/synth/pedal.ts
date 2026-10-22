import type { ParsedSong } from '../../midi/types'
import type { PedalRange } from './types'

/**
 * Convert pedal CC events into closed [start,end] sustain ranges. A note
 * whose natural off-time falls inside any range is held until that
 * range's end (the realtime engine's `pedalHeld` deferred-release
 * behaviour, expressed declaratively for offline scheduling).
 *
 * If the song ends with the pedal still down, the open range is
 * truncated at `endTime` so trailing notes still release within the
 * rendered window.
 */
export function buildPedalRanges(events: ParsedSong['pedals'], endTime: number): PedalRange[] {
  const ranges: PedalRange[] = []
  let down = false
  let downStart = 0
  for (const ev of events) {
    const isDown = ev.value >= 0.5
    if (isDown && !down) {
      down = true
      downStart = ev.time
    } else if (!isDown && down) {
      down = false
      ranges.push({ start: downStart, end: ev.time })
    }
  }
  if (down) ranges.push({ start: downStart, end: endTime })
  return ranges
}

export function findRangeContaining(ranges: PedalRange[], t: number): PedalRange | null {
  // Linear scan — pedal range counts are small (dozens at most for a
  // typical piano piece), and ranges are sorted, so a binary search
  // would just be ceremony for no measurable win.
  for (const r of ranges) {
    if (t < r.start) return null
    if (t < r.end) return r
  }
  return null
}
