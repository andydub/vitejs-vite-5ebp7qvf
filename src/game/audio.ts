import type { Car, Controls } from './car'
import { ENGINE_LOOPS } from './engineLoops'

// ---------------------------------------------------------------------------
// Audio del juego con Web Audio.
//
// El motor del jugador mezcla loops del motor real (grabados de un onboard de
// un Sport 4, cortados por frecuencia de encendido en engine_loops.py) con
// una caja de cambios simulada, limitador, petardeo al levantar y distorsión
// de escape. Encima van capas sintetizadas: tierra y piedras contra el piso,
// derrape, viento, y los rivales más cercanos con estéreo y efecto Doppler.
// ---------------------------------------------------------------------------

/** Fuentes de audio: embebidas (página de un solo archivo) o del servidor. */
declare global {
  interface Window {
    __SPORT4_AUDIO?: Record<string, string>
  }
}

export function audioSrc(key: string): string {
  const embedded = window.__SPORT4_AUDIO?.[key]
  if (embedded) return embedded
  const file = key.includes('.') ? key : `${key}.mp3`
  return `${import.meta.env.BASE_URL}audio/${file}`
}

/** Caja de cambios: relaciones por marcha, diferencial y radio de rueda. */
const GEARS = [2.9, 2.0, 1.5, 1.2, 1.0]
const FINAL_DRIVE = 4.1
const WHEEL_CIRC = 2 * Math.PI * 0.3
const RPM_IDLE = 1700
const RPM_LIMIT = 8100
const RPM_SHIFT_UP = 7850
const RPM_SHIFT_DOWN = 4300
const SHIFT_TIME = 0.14
const SPEED_OF_SOUND = 343

/** rpm del motor para una velocidad en una marcha dada. */
function rpmAt(speed: number, gear: number): number {
  return (speed / WHEEL_CIRC) * 60 * GEARS[gear] * FINAL_DRIVE
}

/** Marcha "automática" para un rival: la más larga que lo deje por encima del rango útil. */
function autoGear(speed: number): number {
  for (let g = 0; g < GEARS.length; g++) {
    if (rpmAt(speed, g) <= RPM_SHIFT_UP || g === GEARS.length - 1) return g
  }
  return GEARS.length - 1
}

interface Loop {
  hz: number
  throttle: 'on' | 'off'
  buffer: AudioBuffer
}

/** Un juego de loops sonando a la vez; `set(hz, mix)` reparte ganancias entre los vecinos. */
class LoopBank {
  private sources: { loop: Loop; src: AudioBufferSourceNode; gain: GainNode }[] = []
  private on: Loop[]
  private off: Loop[]
  private level: number

  constructor(ctx: AudioContext, loops: Loop[], out: AudioNode, level: number) {
    this.level = level
    this.on = loops.filter((l) => l.throttle === 'on').sort((a, b) => a.hz - b.hz)
    this.off = loops.filter((l) => l.throttle === 'off').sort((a, b) => a.hz - b.hz)
    for (const loop of loops) {
      const src = ctx.createBufferSource()
      src.buffer = loop.buffer
      src.loop = true
      // Cada loop arranca en un punto distinto para que no se alineen los ciclos.
      const gain = ctx.createGain()
      gain.gain.value = 0
      src.connect(gain).connect(out)
      src.start(0, Math.random() * loop.buffer.duration)
      this.sources.push({ loop, src, gain })
    }
  }

  /** Reparte el nivel entre los dos loops que rodean `hz` en cada juego (a fondo / levantado). */
  set(hz: number, throttleMix: number, level: number, t: number, tc = 0.03) {
    const weights = new Map<Loop, number>()
    const spread = (set: Loop[], amount: number) => {
      if (!set.length || amount <= 0) return
      let lo = -1
      for (let i = 0; i < set.length; i++) if (set[i].hz <= hz) lo = i
      if (lo < 0) {
        weights.set(set[0], (weights.get(set[0]) ?? 0) + amount)
      } else if (lo === set.length - 1) {
        weights.set(set[lo], (weights.get(set[lo]) ?? 0) + amount)
      } else {
        const a = set[lo]
        const b = set[lo + 1]
        const k = (Math.log(hz) - Math.log(a.hz)) / (Math.log(b.hz) - Math.log(a.hz))
        // Fundido con potencia constante.
        weights.set(a, (weights.get(a) ?? 0) + amount * Math.cos((k * Math.PI) / 2))
        weights.set(b, (weights.get(b) ?? 0) + amount * Math.sin((k * Math.PI) / 2))
      }
    }
    spread(this.on, Math.sqrt(throttleMix))
    spread(this.off, Math.sqrt(1 - throttleMix))
    for (const s of this.sources) {
      const w = (weights.get(s.loop) ?? 0) * level * this.level
      s.gain.gain.setTargetAtTime(w, t, tc)
      if (w > 0.0005) s.src.playbackRate.setTargetAtTime(hz / s.loop.hz, t, tc)
    }
  }

  stop() {
    for (const s of this.sources) {
      try {
        s.src.stop()
      } catch {
        /* ya detenido */
      }
    }
  }
}

function noiseBuffer(ctx: AudioContext, seconds: number, pink = false): AudioBuffer {
  const n = Math.floor(ctx.sampleRate * seconds)
  const buf = ctx.createBuffer(1, n, ctx.sampleRate)
  const d = buf.getChannelData(0)
  let b0 = 0
  let b1 = 0
  let b2 = 0
  for (let i = 0; i < n; i++) {
    const w = Math.random() * 2 - 1
    if (pink) {
      b0 = 0.997 * b0 + 0.029591 * w
      b1 = 0.985 * b1 + 0.032534 * w
      b2 = 0.95 * b2 + 0.048056 * w
      d[i] = (b0 + b1 + b2 + w * 0.05) * 3
    } else d[i] = w
  }
  return buf
}

/** Curva de saturación suave para el escape. */
function shaperCurve(drive: number): Float32Array {
  const n = 1024
  const c = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1
    c[i] = Math.tanh(x * drive) / Math.tanh(drive)
  }
  return c
}

/** Un rival audible: loops propios, paneo, filtro por distancia y Doppler. */
class RivalVoice {
  bank: LoopBank
  pan: StereoPannerNode
  filter: BiquadFilterNode
  gain: GainNode
  carId = -1
  lastSpeed = 0

  constructor(ctx: AudioContext, loops: Loop[], out: AudioNode) {
    this.gain = ctx.createGain()
    this.gain.gain.value = 0
    this.filter = ctx.createBiquadFilter()
    this.filter.type = 'lowpass'
    this.filter.frequency.value = 3000
    this.pan = ctx.createStereoPanner()
    this.filter.connect(this.pan).connect(this.gain).connect(out)
    this.bank = new LoopBank(ctx, loops, this.filter, 1)
  }
}

export class EngineAudio {
  private ctx: AudioContext | null = null
  private master!: GainNode
  private engineBus!: GainNode
  private engineGain!: GainNode
  private shaper!: WaveShaperNode
  private bank: LoopBank | null = null
  private rivals: RivalVoice[] = []
  private rivalLoops: Loop[] = []
  private dirtGain!: GainNode
  private dirtFilter!: BiquadFilterNode
  private skidGain!: GainNode
  private windGain!: GainNode
  private windFilter!: BiquadFilterNode
  private stoneBuf!: AudioBuffer
  private popBuf!: AudioBuffer
  private clunkBuf!: AudioBuffer
  private nextStone = 0
  private nextPop = 0
  private loaded = false
  private disposed = false
  private analyser: AnalyserNode | null = null
  private unwake: (() => void) | null = null

  /** Nivel RMS de la salida (0..1), para pruebas automatizadas. */
  get level(): number {
    if (!this.analyser) return 0
    const d = new Float32Array(this.analyser.fftSize)
    this.analyser.getFloatTimeDomainData(d)
    let s = 0
    for (let i = 0; i < d.length; i++) s += d[i] * d[i]
    return Math.sqrt(s / d.length)
  }

  get ready(): boolean {
    return this.loaded
  }

  // Estado del motor simulado.
  rpm = RPM_IDLE
  gear = 0
  private shiftTimer = 0
  private shiftTo = 0
  private throttleMix = 0
  private limiterPhase = 0
  private limiterCut = false
  private lastThrottle = 0
  private blipTimer = 0
  private blipRpm = RPM_IDLE
  private time = 0
  private racingTime = 0

  start() {
    try {
      const Ctx = window.AudioContext
      if (!Ctx) return
      const ctx = new Ctx()
      this.ctx = ctx
      this.master = ctx.createGain()
      this.master.gain.value = 0.75
      const comp = ctx.createDynamicsCompressor()
      comp.threshold.value = -14
      comp.knee.value = 12
      comp.ratio.value = 3
      comp.attack.value = 0.005
      comp.release.value = 0.15
      this.master.connect(comp).connect(ctx.destination)
      this.analyser = ctx.createAnalyser()
      this.analyser.fftSize = 1024
      comp.connect(this.analyser)

      // Motor del jugador: loops -> saturación de escape -> ecualización -> nivel.
      this.engineBus = ctx.createGain()
      this.engineBus.gain.value = 1
      this.shaper = ctx.createWaveShaper()
      this.shaper.curve = shaperCurve(1.6)
      this.shaper.oversample = '2x'
      const body = ctx.createBiquadFilter()
      body.type = 'peaking'
      body.frequency.value = 180
      body.Q.value = 0.8
      body.gain.value = 3
      const air = ctx.createBiquadFilter()
      air.type = 'highshelf'
      air.frequency.value = 2500
      air.gain.value = -2
      this.engineGain = ctx.createGain()
      this.engineGain.gain.value = 0
      this.engineBus.connect(this.shaper).connect(body).connect(air).connect(this.engineGain).connect(this.master)

      // Tierra: ruido rosa filtrado que crece con la velocidad, más fuerte fuera de la pista.
      const dirt = ctx.createBufferSource()
      dirt.buffer = noiseBuffer(ctx, 3, true)
      dirt.loop = true
      this.dirtFilter = ctx.createBiquadFilter()
      this.dirtFilter.type = 'bandpass'
      this.dirtFilter.frequency.value = 900
      this.dirtFilter.Q.value = 0.5
      this.dirtGain = ctx.createGain()
      this.dirtGain.gain.value = 0
      dirt.connect(this.dirtFilter).connect(this.dirtGain).connect(this.master)
      dirt.start()

      // Derrape: siseo de las cubiertas arrastrando sobre la tierra.
      const skid = ctx.createBufferSource()
      skid.buffer = noiseBuffer(ctx, 2.3, false)
      skid.loop = true
      const skidFilter = ctx.createBiquadFilter()
      skidFilter.type = 'bandpass'
      skidFilter.frequency.value = 2200
      skidFilter.Q.value = 0.9
      this.skidGain = ctx.createGain()
      this.skidGain.gain.value = 0
      skid.connect(skidFilter).connect(this.skidGain).connect(this.master)
      skid.start()

      // Viento: ruido grave que sube con el cuadrado de la velocidad.
      const wind = ctx.createBufferSource()
      wind.buffer = noiseBuffer(ctx, 2.7, true)
      wind.loop = true
      this.windFilter = ctx.createBiquadFilter()
      this.windFilter.type = 'lowpass'
      this.windFilter.frequency.value = 300
      this.windGain = ctx.createGain()
      this.windGain.gain.value = 0
      wind.connect(this.windFilter).connect(this.windGain).connect(this.master)
      wind.start()

      // Golpes cortos: piedras contra el piso, petardeo del escape y el "clac" del cambio.
      this.stoneBuf = this.burst(0.018, 1)
      this.popBuf = this.burst(0.05, 0.35)
      this.clunkBuf = this.burst(0.03, 0.2)

      void ctx.resume()
      // Si el navegador lo dejó suspendido, se reanuda con el primer toque o tecla.
      const wake = () => {
        if (this.ctx && this.ctx.state !== 'running') void this.ctx.resume()
      }
      window.addEventListener('pointerdown', wake)
      window.addEventListener('keydown', wake)
      this.unwake = () => {
        window.removeEventListener('pointerdown', wake)
        window.removeEventListener('keydown', wake)
      }
      void this.loadLoops()
    } catch {
      this.ctx = null
    }
  }

  /** Ráfaga de ruido con caída exponencial; `tone` en 0..1 baja el brillo. */
  private burst(seconds: number, tone: number): AudioBuffer {
    const ctx = this.ctx!
    const n = Math.floor(ctx.sampleRate * seconds)
    const buf = ctx.createBuffer(1, n, ctx.sampleRate)
    const d = buf.getChannelData(0)
    let lp = 0
    for (let i = 0; i < n; i++) {
      const w = Math.random() * 2 - 1
      lp += (w - lp) * tone
      d[i] = lp * Math.exp((-6 * i) / n)
    }
    return buf
  }

  private async loadLoops() {
    const ctx = this.ctx!
    const loops: Loop[] = []
    await Promise.all(
      ENGINE_LOOPS.map(async (l) => {
        try {
          const src = audioSrc(`engine/${l.file}`)
          let data: ArrayBuffer
          if (src.startsWith('data:')) {
            // Embebido en la página: se decodifica a mano. En el Artifact la
            // política de seguridad no deja hacer fetch de URLs data:.
            const bin = atob(src.slice(src.indexOf(',') + 1))
            const bytes = new Uint8Array(bin.length)
            for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
            data = bytes.buffer
          } else {
            data = await (await fetch(src)).arrayBuffer()
          }
          const buffer = await ctx.decodeAudioData(data)
          loops.push({ hz: l.hz, throttle: l.throttle, buffer })
        } catch (err) {
          console.warn('No se pudo cargar el loop de motor', l.file, err)
        }
      }),
    )
    if (this.disposed || !loops.length) return
    this.bank = new LoopBank(ctx, loops, this.engineBus, 1)
    // Rivales: sólo loops "a fondo", un subconjunto para no multiplicar fuentes.
    const on = loops.filter((l) => l.throttle === 'on').sort((a, b) => a.hz - b.hz)
    const wanted = [58, 102, 157, 224, 276]
    this.rivalLoops = wanted.map((hz) => on.reduce((best, l) => (Math.abs(l.hz - hz) < Math.abs(best.hz - hz) ? l : best), on[0])).filter((l, i, arr) => arr.indexOf(l) === i)
    for (let i = 0; i < 3; i++) this.rivals.push(new RivalVoice(ctx, this.rivalLoops, this.master))
    this.loaded = true
  }

  /** Dispara un golpe corto (piedra, petardeo, cambio) por el bus indicado. */
  private hit(buf: AudioBuffer, when: number, gain: number, rate: number, dest: AudioNode) {
    const ctx = this.ctx!
    const src = ctx.createBufferSource()
    src.buffer = buf
    src.playbackRate.value = rate
    const g = ctx.createGain()
    g.gain.value = gain
    src.connect(g).connect(dest)
    src.start(when)
  }

  /**
   * Actualiza todo el audio. `phase` es la fase de la carrera: en la previa el
   * motor queda a ralentí; en la cuenta regresiva el piloto acelera en vacío.
   */
  update(cars: Car[], player: Car, controls: Controls, phase: string, dt: number) {
    const ctx = this.ctx
    if (!ctx) return
    this.time += dt
    const t = ctx.currentTime
    const racing = phase === 'racing' || phase === 'finished'
    const throttle = racing ? controls.throttle : 0
    const speed = Math.max(0, player.speed)

    // --- Caja de cambios y rpm ---
    let target: number
    if (this.shiftTimer > 0) {
      this.shiftTimer -= dt
      if (this.shiftTimer <= 0) this.gear = this.shiftTo
      target = rpmAt(speed, this.shiftTo)
    } else {
      const inGear = rpmAt(speed, this.gear)
      if (inGear > RPM_SHIFT_UP && this.gear < GEARS.length - 1 && throttle > 0.2) {
        this.shiftTo = this.gear + 1
        this.shiftTimer = SHIFT_TIME
        this.hit(this.clunkBuf, t, 0.5, 0.8, this.master)
      } else if (inGear < RPM_SHIFT_DOWN && this.gear > 0 && rpmAt(speed, this.gear - 1) < RPM_SHIFT_UP) {
        this.shiftTo = this.gear - 1
        this.shiftTimer = SHIFT_TIME * 0.8
        this.hit(this.clunkBuf, t, 0.35, 0.7, this.master)
      }
      target = rpmAt(speed, this.gear)
    }
    // Largada: el embrague patina y el motor sube aunque el auto no se mueva.
    if (racing && throttle > 0 && speed < 8) {
      const launch = 3800 + throttle * 3600
      target = Math.max(target, launch * (1 - speed / 8))
    }
    // Rueda patinando en la tierra suelta: el motor se pasa de vueltas.
    if (!player.onAsphalt && throttle > 0.3) target += 900 * throttle
    // En la cuenta regresiva acelera en vacío a golpes.
    if (phase === 'countdown') {
      this.blipTimer -= dt
      if (this.blipTimer <= 0) {
        this.blipTimer = 0.35 + Math.random() * 0.6
        this.blipRpm = this.blipRpm > 3000 ? RPM_IDLE + 400 : 3500 + Math.random() * 2500
      }
      target = Math.max(target, this.blipRpm)
    }
    target = Math.max(RPM_IDLE, Math.min(RPM_LIMIT + 200, target))
    // El motor sube más rápido con acelerador que lo que cae.
    const rising = target > this.rpm
    const rate = this.shiftTimer > 0 ? 18 : rising ? 9 + throttle * 6 : 6
    this.rpm += (target - this.rpm) * Math.min(1, dt * rate)
    // Limitador: corta encendido a golpes.
    let cut = 1
    if (this.rpm >= RPM_LIMIT && throttle > 0.5 && this.shiftTimer <= 0) {
      this.limiterPhase += dt
      if (this.limiterPhase > 0.04) {
        this.limiterPhase = 0
        this.limiterCut = !this.limiterCut
      }
      if (this.limiterCut) {
        cut = 0.35
        this.rpm -= 60
      }
    } else this.limiterCut = false

    // Mezcla a fondo / levantado, y corte al cambiar.
    const wantMix = this.shiftTimer > 0 ? 0 : throttle
    this.throttleMix += (wantMix - this.throttleMix) * Math.min(1, dt * (wantMix > this.throttleMix ? 14 : 8))
    const hz = this.rpm / 30
    const loudness = (0.55 + 0.45 * this.throttleMix) * (this.shiftTimer > 0 ? 0.55 : 1) * cut
    this.bank?.set(hz, this.throttleMix, loudness, t)
    // Nivel general del motor: de fondo mientras habla el relator (previa y
    // cuenta regresiva), y sube del todo unos segundos después de largar.
    if (racing) this.racingTime += dt
    else this.racingTime = 0
    const engineLevel = racing ? 0.2 + 0.18 * Math.min(1, Math.max(0, (this.racingTime - 3) / 5)) : phase === 'countdown' ? 0.2 : 0.1
    this.engineGain.gain.setTargetAtTime(engineLevel, t, 0.5)
    // Más distorsión a fondo y en vueltas altas.
    const driveIdx = Math.round(this.throttleMix * 2 + (this.rpm > 6500 ? 1 : 0))
    if (driveIdx !== this.lastDrive) {
      this.lastDrive = driveIdx
      this.shaper.curve = shaperCurve(1.3 + driveIdx * 0.6)
    }

    // Petardeo al levantar el pie en vueltas altas, y algún tiro suelto en retención.
    if (racing && this.lastThrottle > 0.5 && throttle < 0.15 && this.rpm > 5200) {
      const n = 2 + Math.floor(Math.random() * 3)
      for (let i = 0; i < n; i++) this.hit(this.popBuf, t + 0.05 + Math.random() * 0.5, 0.7 + Math.random() * 0.5, 0.7 + Math.random() * 0.6, this.engineBus)
      this.nextPop = t + 0.6
    } else if (racing && throttle < 0.15 && this.rpm > 4500 && t > this.nextPop) {
      if (Math.random() < dt * 2.5) this.hit(this.popBuf, t, 0.4 + Math.random() * 0.4, 0.6 + Math.random() * 0.7, this.engineBus)
      this.nextPop = t + 0.08
    }
    this.lastThrottle = throttle

    // --- Capas del piso ---
    const k = Math.min(1, speed / 30)
    const offRoad = player.onAsphalt ? 0 : 1
    this.dirtGain.gain.setTargetAtTime((0.045 + offRoad * 0.12) * k, t, 0.08)
    this.dirtFilter.frequency.setTargetAtTime(500 + k * 1200 + offRoad * 400, t, 0.1)
    const slide = Math.min(1, Math.max(0, (Math.abs(player.lateralSpeed) - 1.2) / 5))
    const braking = controls.brake > 0.5 && speed > 8 ? 0.35 : 0
    this.skidGain.gain.setTargetAtTime((slide * 0.16 + braking * 0.08) * Math.min(1, speed / 10), t, 0.06)
    const w = (speed / 55) ** 2
    this.windGain.gain.setTargetAtTime(Math.min(0.4, w * 0.35), t, 0.15)
    this.windFilter.frequency.setTargetAtTime(200 + w * 900, t, 0.2)
    // Piedras: golpes sueltos, mucho más seguidos fuera de la pista o derrapando.
    const stoneRate = speed > 3 ? (2 + offRoad * 25 + slide * 12) * k : 0
    if (stoneRate > 0) {
      if (this.nextStone < t) this.nextStone = t
      while (this.nextStone < t + 0.12) {
        this.hit(this.stoneBuf, this.nextStone, 0.12 + Math.random() * 0.25, 0.7 + Math.random() * 1.2, this.master)
        this.nextStone += -Math.log(1 - Math.random()) / stoneRate
      }
    } else this.nextStone = t

    // --- Rivales cercanos ---
    if (this.rivals.length) {
      const cos = Math.cos(player.heading)
      const sin = Math.sin(player.heading)
      const near = cars
        .filter((c) => c !== player)
        .map((c) => ({ c, d: Math.hypot(c.x - player.x, c.y - player.y) }))
        .filter((r) => r.d < 110)
        .sort((a, b) => a.d - b.d)
        .slice(0, this.rivals.length)
      // Mantener cada rival en la voz que ya tenía; asignar las libres.
      const voices = this.rivals.slice()
      const assigned: (RivalVoice | null)[] = near.map((r) => {
        const idx = voices.findIndex((v) => v.carId === r.c.id)
        if (idx < 0) return null
        return voices.splice(idx, 1)[0]
      })
      near.forEach((r, i) => {
        let v = assigned[i]
        if (!v) {
          v = voices.shift()!
          v.carId = r.c.id
          v.lastSpeed = r.c.speed
        }
        const dx = r.c.x - player.x
        const dy = r.c.y - player.y
        // Posición relativa al jugador: adelante = +x, derecha = +y.
        const rx = dx * cos + dy * sin
        const ry = -dx * sin + dy * cos
        const d = Math.max(2, r.d)
        // Velocidad radial (positiva alejándose) para el Doppler.
        const vx = Math.cos(r.c.heading) * r.c.speed - Math.cos(player.heading) * player.speed
        const vy = Math.sin(r.c.heading) * r.c.speed - Math.sin(player.heading) * player.speed
        const vr = (vx * dx + vy * dy) / d
        const doppler = SPEED_OF_SOUND / Math.max(200, SPEED_OF_SOUND + vr)
        const accel = (r.c.speed - v.lastSpeed) / Math.max(dt, 1e-3)
        v.lastSpeed = r.c.speed
        const onThrottle = accel > -1.5 ? 1 : 0.55
        const g = r.c.speed > 0.5 ? 0.6 / (1 + (d / 9) ** 2) : 0
        const rpm = Math.max(RPM_IDLE, Math.min(RPM_LIMIT, rpmAt(r.c.speed, autoGear(r.c.speed))))
        v.bank.set((rpm / 30) * doppler, 1, onThrottle, t, 0.05)
        v.gain.gain.setTargetAtTime(g, t, 0.08)
        v.pan.pan.setTargetAtTime(Math.max(-1, Math.min(1, ry / Math.max(4, Math.abs(rx) + Math.abs(ry)))) * 0.85, t, 0.08)
        v.filter.frequency.setTargetAtTime(Math.max(600, 4500 - d * 45), t, 0.1)
      })
      for (const v of voices) {
        if (assigned.includes(v)) continue
        v.gain.gain.setTargetAtTime(0, t, 0.1)
        v.carId = -1
      }
    }
  }

  private lastDrive = -1

  stop() {
    this.disposed = true
    this.unwake?.()
    try {
      this.bank?.stop()
      for (const v of this.rivals) v.bank.stop()
      void this.ctx?.close()
    } catch {
      /* ignorar */
    }
    this.ctx = null
  }
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

  get volume() {
    return this.el.volume
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
