import { aiControls } from './ai'
import { Car, resolveCollisions, type Controls } from './car'
import { Track } from './track'
import { CAR_MODELS, hueOf, type CarModelConfig } from './models'

export type RacePhase = 'intro' | 'countdown' | 'racing' | 'finished'

export interface DriverSpec {
  name: string
  short: string
  number: number
  color: string
  cage: string
  skill: number
  model?: CarModelConfig
  retint: boolean
}

// Grilla de la final, en el orden de cajones del relato de Lucio Aguirre.
// Los modelos 3D reales (29 y 1) se reparten; los demás se retiñen al color del equipo.
export const RIVALS: DriverSpec[] = [
  { name: 'Miguel Alberto Olivera', short: 'M.A. OLIVERA', number: 5, color: '#d4202a', cage: '#ffffff', skill: 0.96, model: CAR_MODELS.car29, retint: true },
  { name: 'Miguel Ángel Olivera', short: 'M.Á. OLIVERA', number: 55, color: '#e8e8e8', cage: '#d4202a', skill: 0.95, model: CAR_MODELS.car1, retint: true },
  { name: 'Román Majstruk', short: 'R. MAJSTRUK', number: 8, color: '#1f8f3a', cage: '#111111', skill: 0.93, model: CAR_MODELS.car29, retint: true },
  { name: 'Federico Rodríguez', short: 'F. RODRÍGUEZ', number: 14, color: '#f2a900', cage: '#111111', skill: 0.92, model: CAR_MODELS.car1, retint: true },
  { name: 'Mario Carreras', short: 'M. CARRERAS', number: 17, color: '#1d5bd8', cage: '#dcdcdc', skill: 0.9, model: CAR_MODELS.car29, retint: true },
  { name: 'Thiago Carreras', short: 'T. CARRERAS', number: 71, color: '#20b2c8', cage: '#111111', skill: 0.88, model: CAR_MODELS.car1, retint: true },
  { name: 'Daniel Gil', short: 'D. GIL', number: 9, color: '#7a2fbf', cage: '#dcdcdc', skill: 0.87, model: CAR_MODELS.car29, retint: true },
  { name: 'David López', short: 'D. LÓPEZ', number: 44, color: '#ff6a00', cage: '#111111', skill: 0.86, model: CAR_MODELS.car1, retint: true },
  { name: 'Diego Pashkowec', short: 'D. PASHKOWEC', number: 23, color: '#3c3c3c', cage: '#ffd500', skill: 0.82, model: CAR_MODELS.car29, retint: true },
  { name: 'Horacio Álvarez', short: 'H. ÁLVAREZ', number: 2, color: '#c8189a', cage: '#111111', skill: 0.85, model: CAR_MODELS.car1, retint: true },
]

export const PLAYER_SPEC: DriverSpec = {
  name: 'Bruno del Pozo',
  short: 'B. DEL POZO',
  number: 1,
  color: '#c9ccd1',
  cage: '#1f5fd6',
  skill: 1,
  model: CAR_MODELS.car1,
  retint: false,
}

/** Fila de la torre de tiempos. */
export interface TowerRow {
  pos: number
  number: number
  short: string
  color: string
  gap: string
  isPlayer: boolean
  finished: boolean
}

export class Race {
  readonly track = new Track()
  readonly cars: Car[]
  readonly player: Car
  phase: RacePhase = 'intro'
  time = 0 // segundos desde el inicio de la simulación
  countdown = 3.5
  introDuration = 59 // segundos de previa (dura lo que el relato)
  private aiBias: number[]
  private results: Car[] = []
  private displayOrder: Car[] = []
  private pendingOrder: { order: Car[]; since: number } | null = null
  private towerCache: TowerRow[] = []
  private towerAt = -Infinity

  readonly totalLaps: number

  constructor(totalLaps: number, playerName: string) {
    this.totalLaps = totalLaps
    const cars: Car[] = []
    // El jugador larga último para que la carrera tenga sentido.
    RIVALS.forEach((r, i) => {
      const car = new Car(i, r.name, r.number, r.color, r.cage, false, r.skill, this.track, i)
      car.short = r.short
      car.model = r.model ?? null
      if (r.model && r.retint) car.modelHue = hueOf(r.color) - r.model.baseHue
      cars.push(car)
    })
    const ps = PLAYER_SPEC
    this.player = new Car(RIVALS.length, playerName || ps.name, ps.number, ps.color, ps.cage, true, 1, this.track, RIVALS.length)
    this.player.short = ps.short
    this.player.model = ps.model ?? null
    cars.push(this.player)
    this.cars = cars
    this.displayOrder = [...cars]
    for (const c of cars) c.height = this.track.groundHeight(c.x, c.y, c.trackIndex)
    this.aiBias = cars.map((_, i) => ((i % 2 === 0 ? -1 : 1) * (1.2 + (i % 3) * 0.6)))
  }

  /** Orden actual de la carrera (los que terminaron primero, luego por progreso). */
  standings(): Car[] {
    const running = this.cars.filter((c) => !c.finished).sort((a, b) => b.progress - a.progress)
    return [...this.results, ...running]
  }

  positionOf(car: Car): number {
    return this.standings().indexOf(car) + 1
  }

  resetPlayer() {
    if (this.phase === 'racing') this.player.resetToTrack(this.track)
  }

  /** Reloj de la previa: sigue el tiempo real (y el audio del relato), no el paso fijo. */
  setIntroTime(t: number) {
    if (this.phase === 'intro') {
      this.time = t
      if (t >= this.introDuration) this.skipIntro()
    }
  }

  /** Termina la previa y arranca la cuenta regresiva. */
  skipIntro() {
    if (this.phase === 'intro') {
      this.phase = 'countdown'
      this.countdown = 3.5
    }
  }

  /**
   * Orden mostrado en la torre: un adelantamiento cambia la tabla solo si se
   * sostiene más de dos segundos.
   */
  private updateDisplayOrder() {
    const actual = this.standings()
    const same = (a: Car[], b: Car[]) => a.length === b.length && a.every((c, i) => c === b[i])
    if (same(actual, this.displayOrder)) {
      this.pendingOrder = null
      return
    }
    if (this.pendingOrder && same(this.pendingOrder.order, actual)) {
      if (this.time - this.pendingOrder.since > 2) {
        this.displayOrder = actual
        this.pendingOrder = null
      }
    } else {
      this.pendingOrder = { order: actual, since: this.time }
    }
  }

  /**
   * Filas de la torre de tiempos con la diferencia respecto del de adelante.
   * Se recalcula una vez por segundo para que los números no bailen.
   */
  tower(): TowerRow[] {
    if (this.time - this.towerAt < 1 && this.towerCache.length) return this.towerCache
    this.towerAt = this.time
    this.towerCache = this.displayOrder.map((c, i) => {
      let gap = 'LÍDER'
      if (i > 0) {
        const ahead = this.displayOrder[i - 1]
        if (c.finished && ahead.finished) gap = `+${(c.finishTime - ahead.finishTime).toFixed(1)}`
        else if (ahead.progress - c.progress > this.track.length) gap = `+${Math.floor((ahead.progress - c.progress) / this.track.length)} V`
        else gap = `+${ahead.gapAhead(c, this.time).toFixed(1)}`
      }
      return { pos: i + 1, number: c.number, short: c.short || c.name.toUpperCase(), color: c.color, gap, isPlayer: c.isPlayer, finished: c.finished }
    })
    return this.towerCache
  }


  step(dt: number, playerControls: Controls) {
    this.time += dt
    if (this.phase === 'intro') {
      if (this.time >= this.introDuration) this.skipIntro()
      return
    }
    if (this.phase === 'countdown') {
      this.countdown -= dt
      if (this.countdown <= 0) {
        this.phase = 'racing'
        for (const c of this.cars) c.lapStartTime = this.time
      }
      return
    }

    for (const c of this.cars) {
      let controls: Controls
      if (c.finished) {
        controls = { throttle: 0.25, brake: 0, steer: aiControls(c, this.track, this.cars, 0).steer }
      } else if (c.isPlayer) {
        controls = playerControls
      } else {
        controls = aiControls(c, this.track, this.cars, this.aiBias[c.id])
      }
      c.update(dt, controls, this.track, this.time)
      if (!c.finished && c.lap > this.totalLaps) {
        c.finished = true
        c.finishTime = this.time
        this.results.push(c)
      }
    }
    resolveCollisions(this.cars)
    this.updateDisplayOrder()

    if (this.player.finished && this.phase === 'racing') {
      this.phase = 'finished'
    }
  }
}
