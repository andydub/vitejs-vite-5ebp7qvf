import { aiControls } from './ai'
import { Car, resolveCollisions, type Controls } from './car'
import { Track } from './track'
import { CAR_MODELS, hueOf, type CarModelConfig } from './models'

export type RacePhase = 'countdown' | 'racing' | 'finished'

// Liveries inspirados en fotos de la categoría. Los modelos 3D reales (29 y 1)
// se reparten entre todos los autos; los demás se retiñen al color del equipo.
const RIVALS: { name: string; number: number; color: string; cage: string; skill: number; model?: CarModelConfig; retint: boolean }[] = [
  { name: 'MG Racing', number: 1, color: '#c9ccd1', cage: '#1f5fd6', skill: 0.95, model: CAR_MODELS.car1, retint: false },
  { name: 'Schiavone', number: 29, color: '#1d5bd8', cage: '#dcdcdc', skill: 0.92, model: CAR_MODELS.car29, retint: false },
  { name: 'H. Álvarez', number: 2, color: '#c8189a', cage: '#111111', skill: 0.88, model: CAR_MODELS.car29, retint: true },
  { name: 'M. Daniele', number: 7, color: '#f26b21', cage: '#222222', skill: 0.82, model: CAR_MODELS.car1, retint: true },
  { name: 'R. Majstruk', number: 21, color: '#2fbf71', cage: '#222222', skill: 0.76, model: CAR_MODELS.car29, retint: true },
]

export class Race {
  readonly track = new Track()
  readonly cars: Car[]
  readonly player: Car
  phase: RacePhase = 'countdown'
  time = 0 // segundos desde el inicio de la simulación
  countdown = 3.5
  private aiBias: number[]
  private results: Car[] = []

  readonly totalLaps: number

  constructor(totalLaps: number, playerName: string) {
    this.totalLaps = totalLaps
    const cars: Car[] = []
    // El jugador larga último para que la carrera tenga sentido.
    RIVALS.forEach((r, i) => {
      const car = new Car(i, r.name, r.number, r.color, r.cage, false, r.skill, this.track, i)
      car.model = r.model ?? null
      if (r.model && r.retint) car.modelHue = hueOf(r.color) - r.model.baseHue
      cars.push(car)
    })
    this.player = new Car(RIVALS.length, playerName, 99, '#ffd500', '#111111', true, 1, this.track, RIVALS.length)
    this.player.model = CAR_MODELS.car1 ?? null
    if (this.player.model) this.player.modelHue = hueOf('#ffd500') - this.player.model.baseHue
    cars.push(this.player)
    this.cars = cars
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

  step(dt: number, playerControls: Controls) {
    this.time += dt
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

    if (this.player.finished && this.phase === 'racing') {
      this.phase = 'finished'
    }
  }
}
