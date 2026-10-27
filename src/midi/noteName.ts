const NOTE_NAMES = [
  'C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B',
] as const

export function midiToName(midi: number): string {
  return `${NOTE_NAMES[midi % 12]}${Math.floor(midi / 12) - 1}`
}

export type PitchLabelFormat = 'letter' | 'letterOctave'
export type Accidental = 'sharp' | 'flat'

const SHARP_LABELS = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'] as const
const FLAT_LABELS = ['C', 'D♭', 'D', 'E♭', 'E', 'F', 'G♭', 'G', 'A♭', 'A', 'B♭', 'B'] as const

/** Display label for a pitch, e.g. "C♯" or "D♭4" (middle C = C4). */
export function pitchLabel(midi: number, format: PitchLabelFormat, accidental: Accidental): string {
  const name = (accidental === 'flat' ? FLAT_LABELS : SHARP_LABELS)[midi % 12]
  return format === 'letterOctave' ? `${name}${Math.floor(midi / 12) - 1}` : name
}
