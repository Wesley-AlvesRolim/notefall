/**
 * "Task complete" chime played when an export finishes successfully.
 *
 * Voice — a marimba-like wooden bar: a sine fundamental plus the bar's
 * own overtones at 4× and 9.9× the fundamental (a tuned marimba bar's
 * first two modes), which die much faster than the fundamental, and a
 * very short low-passed noise burst for the mallet contact. The fast
 * overtone decay is what makes it read as wood rather than a synth
 * bell.
 *
 * Form — three rising notes, G5 · C6 … E6: two quick strikes, then the
 * third after a short breath, so the figure ends on an open "done"
 * rather than a fanfare.
 *
 *   Total length: ~0.9 s.
 *
 * Uses a fresh `AudioContext` rather than the engine's Tone.js
 * context so the chime works even when no song is loaded / piano
 * isn't initialised, can't collide with a piano voice still tailing
 * off, and gets closed right after so it doesn't keep the audio
 * device awake. Fails silently — autoplay policy / context
 * creation errors aren't worth surfacing from a notification chime.
 */
export function playExportCompleteChime(): void {
  try {
    const ctx = new AudioContext()

    // Gentle compression so overlapping strikes don't clip.
    const out = ctx.createDynamicsCompressor()
    out.threshold.value = -12
    out.ratio.value = 3
    out.attack.value = 0.002
    out.release.value = 0.1
    const master = ctx.createGain()
    master.gain.value = 0.9
    master.connect(out).connect(ctx.destination)

    // One decaying sine partial: fast linear attack, exponential decay.
    const partial = (freq: number, t0: number, peak: number, decay: number, attack: number) => {
      const osc = ctx.createOscillator()
      osc.type = 'sine'
      osc.frequency.value = freq
      const g = ctx.createGain()
      g.gain.setValueAtTime(0, t0)
      g.gain.linearRampToValueAtTime(peak, t0 + attack)
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + decay)
      osc.connect(g).connect(master)
      osc.start(t0)
      osc.stop(t0 + decay + 0.05)
    }

    // Mallet contact: a 12 ms noise burst, cubic fade, low-passed.
    const knock = (t0: number, peak: number) => {
      const n = Math.ceil(ctx.sampleRate * 0.012)
      const buf = ctx.createBuffer(1, n, ctx.sampleRate)
      const d = buf.getChannelData(0)
      for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / n, 3)
      const src = ctx.createBufferSource()
      src.buffer = buf
      const lp = ctx.createBiquadFilter()
      lp.type = 'lowpass'
      lp.frequency.value = 3000
      const g = ctx.createGain()
      g.gain.value = peak
      src.connect(lp).connect(g).connect(master)
      src.start(t0)
    }

    const strike = (midi: number, startSec: number, vel: number) => {
      const t0 = ctx.currentTime + startSec
      const f = 440 * Math.pow(2, (midi - 69) / 12)
      partial(f, t0, vel, 0.55, 0.002)
      partial(f * 4, t0, vel * 0.25, 0.12, 0.001)
      partial(f * 9.9, t0, vel * 0.06, 0.05, 0.001)
      knock(t0, vel * 0.15)
    }

    // G5 · C6 … E6, each a little louder so the line climbs.
    strike(79, 0.02, 0.5)
    strike(84, 0.12, 0.55)
    strike(88, 0.34, 0.6)

    // Auto-close once the last strike (0.34 + 0.55 s) has decayed.
    setTimeout(() => {
      void ctx.close().catch(() => undefined)
    }, 1200)
  } catch {
    /* graceful no-op */
  }
}
