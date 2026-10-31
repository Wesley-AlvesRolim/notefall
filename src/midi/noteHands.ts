import type { Finger, Hand, NoteEvent, ParsedSong } from './types'

/**
 * Hand / finger assignments ride in the project manifest, not in the SMF (MIDI has no place for
 * them). Each entry names its note by pitch + start time in ms; on load it goes back to the note
 * of that pitch starting nearest that time (within `MATCH_MS`). Same-pitch notes never overlap,
 * so the match is unambiguous even after the SMF round trip quantises times to ticks.
 */
export type NoteHandEntry = [midi: number, timeMs: number, hand: Hand | null, finger: Finger | null]

const MATCH_MS = 10

export function collectNoteHands(song: ParsedSong): NoteHandEntry[] {
  const out: NoteHandEntry[] = []
  for (const n of song.notes) {
    if (n.hand === undefined && n.finger === undefined) continue
    out.push([n.midi, Math.round(n.time * 1000), n.hand ?? null, n.finger ?? null])
  }
  return out
}

export function applyNoteHands(song: ParsedSong, entries: readonly NoteHandEntry[] | null | undefined): ParsedSong {
  if (!entries || entries.length === 0) return song
  const byPitch = new Map<number, NoteEvent[]>()
  for (const n of song.notes) {
    const list = byPitch.get(n.midi)
    if (list) list.push(n)
    else byPitch.set(n.midi, [n])
  }
  const assigned = new Map<number, { hand?: Hand; finger?: Finger }>()
  for (const [midi, timeMs, hand, finger] of entries) {
    const list = byPitch.get(midi)
    if (!list) continue
    let best: NoteEvent | null = null
    let bestDist = MATCH_MS
    for (const n of list) {
      const d = Math.abs(n.time * 1000 - timeMs)
      if (d <= bestDist) {
        best = n
        bestDist = d
      }
    }
    if (best) assigned.set(best.id, { hand: hand ?? undefined, finger: finger ?? undefined })
  }
  if (assigned.size === 0) return song
  return {
    ...song,
    notes: song.notes.map((n) => {
      const a = assigned.get(n.id)
      if (!a) return n
      const next: NoteEvent = { ...n }
      if (a.hand) next.hand = a.hand
      if (a.finger) next.finger = a.finger
      return next
    }),
  }
}

const handIndex = new WeakMap<ParsedSong, Map<number, NoteEvent>>()

/** Note by id for a song, cached per song object (renderers look up hands per note per frame). */
export function noteById(song: ParsedSong, id: number): NoteEvent | undefined {
  let index = handIndex.get(song)
  if (!index) {
    index = new Map()
    for (const n of song.notes) index.set(n.id, n)
    handIndex.set(song, index)
  }
  return index.get(id)
}

// The live song, registered by the store (this module can't import the store: the store
// imports the colour code that reads hands, which would make an import cycle).
let songSource: () => ParsedSong | null = () => null
export function setHandSongSource(get: () => ParsedSong | null): void {
  songSource = get
}

/** Hand of a note of the current song by id (undefined for live notes or unassigned ones). */
export function handOfNote(id: number | undefined): Hand | undefined {
  if (id === undefined) return undefined
  const song = songSource()
  return song ? noteById(song, id)?.hand : undefined
}
