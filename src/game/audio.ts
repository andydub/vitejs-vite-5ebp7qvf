/** Sonido de motor sintetizado con Web Audio (sin archivos externos). */
export class EngineAudio {
  private ctx: AudioContext | null = null
  private osc: OscillatorNode | null = null
  private osc2: OscillatorNode | null = null
  private gain: GainNode | null = null
  private filter: BiquadFilterNode | null = null
  private rpm = 0.2

  start() {
    try {
      const Ctx = window.AudioContext
      if (!Ctx) return
      this.ctx = new Ctx()
      this.osc = this.ctx.createOscillator()
      this.osc.type = 'sawtooth'
      this.osc2 = this.ctx.createOscillator()
      this.osc2.type = 'square'
      this.filter = this.ctx.createBiquadFilter()
      this.filter.type = 'lowpass'
      this.filter.frequency.value = 600
      this.gain = this.ctx.createGain()
      this.gain.gain.value = 0
      const g2 = this.ctx.createGain()
      g2.gain.value = 0.35
      this.osc.connect(this.filter)
      this.osc2.connect(g2).connect(this.filter)
      this.filter.connect(this.gain).connect(this.ctx.destination)
      this.osc.start()
      this.osc2.start()
      void this.ctx.resume()
    } catch {
      this.ctx = null
    }
  }

  /** speed en m/s, throttle 0..1 */
  update(speed: number, throttle: number, dt: number) {
    if (!this.ctx || !this.osc || !this.osc2 || !this.gain || !this.filter) return
    // "Cambios" ficticios: las rpm suben con la velocidad y caen al cambiar.
    const gearSpan = 14 // m/s por marcha
    const inGear = (speed % gearSpan) / gearSpan
    const targetRpm = 0.2 + inGear * 0.7 + throttle * 0.1
    this.rpm += (targetRpm - this.rpm) * Math.min(1, dt * 8)
    const base = 55 + this.rpm * 180
    const t = this.ctx.currentTime
    this.osc.frequency.setTargetAtTime(base, t, 0.03)
    this.osc2.frequency.setTargetAtTime(base * 0.5, t, 0.03)
    this.filter.frequency.setTargetAtTime(400 + this.rpm * 2200 + throttle * 600, t, 0.05)
    this.gain.gain.setTargetAtTime(0.05 + this.rpm * 0.08 + throttle * 0.05, t, 0.05)
  }

  stop() {
    try {
      this.osc?.stop()
      this.osc2?.stop()
      void this.ctx?.close()
    } catch {
      /* ignorar */
    }
    this.ctx = null
  }
}

/** Fuentes de audio: embebidas (página de un solo archivo) o del servidor. */
declare global {
  interface Window {
    __SPORT4_AUDIO?: Record<string, string>
  }
}

export function audioSrc(key: 'menu' | 'relato' | 'largada'): string {
  const embedded = window.__SPORT4_AUDIO?.[key]
  if (embedded) return embedded
  return `${import.meta.env.BASE_URL}audio/${key}.mp3`
}

/** Reproductor simple con fundidos, para música y relato. */
export class TrackPlayer {
  private el: HTMLAudioElement
  private fadeTimer: number | null = null

  constructor(src: string, loop: boolean) {
    this.el = new Audio(src)
    this.el.loop = loop
    this.el.preload = 'auto'
    this.el.volume = 0
  }

  /** Intenta reproducir; si el navegador lo bloquea, devuelve false. */
  async play(volume: number): Promise<boolean> {
    this.el.volume = volume
    try {
      await this.el.play()
      return true
    } catch {
      return false
    }
  }

  get playing() {
    return !this.el.paused
  }

  fadeTo(volume: number, seconds: number, thenPause = false) {
    if (this.fadeTimer !== null) window.clearInterval(this.fadeTimer)
    const start = this.el.volume
    const t0 = performance.now()
    this.fadeTimer = window.setInterval(() => {
      const k = Math.min(1, (performance.now() - t0) / (seconds * 1000))
      this.el.volume = start + (volume - start) * k
      if (k >= 1) {
        if (this.fadeTimer !== null) window.clearInterval(this.fadeTimer)
        this.fadeTimer = null
        if (thenPause) this.el.pause()
      }
    }, 50)
  }

  stop() {
    if (this.fadeTimer !== null) window.clearInterval(this.fadeTimer)
    this.fadeTimer = null
    this.el.pause()
    this.el.currentTime = 0
  }

  dispose() {
    this.stop()
    this.el.src = ''
  }
}
