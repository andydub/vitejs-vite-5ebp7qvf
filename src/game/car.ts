import { Track, wrapAngle } from './track'

// Parámetros aproximados de un Sport 4 (auto de tierra con motor 4 cilindros
// preparado, ~130 CV, ~600 kg, ruedas delanteras descubiertas).
export const CAR_SPEC = {
  massKg: 600,
  powerW: 130 * 735.5,
  maxTractionN: 4200,
  dragCoef: 0.5, // N / (m/s)^2
  rollingN: 220,
  brakeDecel: 7.5, // m/s^2
  wheelbaseM: 2.3,
  maxSteerRad: 0.6,
  gripTrack: 1.0, // g laterales sobre tierra compactada
  gripGrass: 0.4,
  lengthM: 3.9,
  widthM: 1.8,
}

export interface Controls {
  throttle: number // 0..1
  brake: number // 0..1
  steer: number // -1..1 (negativo izquierda)
}

export class Car {
  x: number
  y: number
  heading: number
  speed = 0 // m/s (longitudinal)
  lateralSpeed = 0 // m/s (positivo hacia la derecha del auto)
  steerAngle = 0
  trackIndex: number
  onAsphalt = true
  progress = 0 // metros recorridos desde la largada (con vueltas)
  lap = 1
  lapStartTime = 0
  lapTimes: number[] = []
  bestLap = Infinity
  finished = false
  finishTime = 0
  private sectorsHit = new Set<number>()
  private lastIndex: number

  readonly id: number
  readonly name: string
  readonly number: number
  readonly color: string
  readonly isPlayer: boolean
  readonly skill: number // 0..1, afecta a la IA

  constructor(
    id: number,
    name: string,
    number: number,
    color: string,
    isPlayer: boolean,
    skill: number,
    track: Track,
    gridSlot: number,
  ) {
    this.id = id
    this.name = name
    this.number = number
    this.color = color
    this.isPlayer = isPlayer
    this.skill = skill
    // Grilla: filas de a dos, 6 m entre filas, detrás de la largada.
    const back = 10 + Math.floor(gridSlot / 2) * 8
    const side = (gridSlot % 2 === 0 ? -1 : 1) * 2.6
    const p = track.pointAt(track.points.length - back)
    const nx = -Math.sin(p.heading)
    const ny = Math.cos(p.heading)
    this.x = p.x + nx * side
    this.y = p.y + ny * side
    this.heading = p.heading
    this.trackIndex = track.points.length - back
    this.lastIndex = this.trackIndex
    this.progress = -back
  }

  update(dt: number, c: Controls, track: Track, timeNow: number) {
    const spec = CAR_SPEC
    const grip = this.onAsphalt ? spec.gripTrack : spec.gripGrass
    const gravity = 9.81

    // Fuerzas longitudinales.
    const v = Math.max(this.speed, 0)
    let force = 0
    if (c.throttle > 0) {
      const tractionCap = this.onAsphalt ? spec.maxTractionN : spec.maxTractionN * 0.35
      force += Math.min(tractionCap, spec.powerW / Math.max(v, 3)) * c.throttle
    }
    force -= spec.dragCoef * v * v + spec.rollingN
    if (!this.onAsphalt) force -= 450 + 9 * v
    let accel = force / spec.massKg
    if (c.brake > 0) accel -= spec.brakeDecel * c.brake * (this.onAsphalt ? 1 : 0.5)
    this.speed += accel * dt
    if (this.speed < 0) this.speed = 0

    // Dirección: suavizado hacia el volante pedido, con menos ángulo a alta velocidad.
    const speedFactor = 1 / (1 + v / 28)
    const targetSteer = c.steer * spec.maxSteerRad * speedFactor
    const steerRate = 6
    this.steerAngle += Math.max(-steerRate * dt, Math.min(steerRate * dt, targetSteer - this.steerAngle))

    // Giro: el auto rota más rápido de lo que la tierra puede sostener y
    // eso genera velocidad lateral (derrape), que el agarre va frenando.
    let yawRate = (v / spec.wheelbaseM) * Math.tan(this.steerAngle)
    const maxYaw = v > 0.5 ? (grip * gravity * 1.35) / v : 10
    if (Math.abs(yawRate) > maxYaw) yawRate = Math.sign(yawRate) * maxYaw
    const prevHeading = this.heading
    this.heading = wrapAngle(this.heading + yawRate * dt)
    // Al rotar el chasis, parte de la velocidad longitudinal pasa a lateral.
    const dh = wrapAngle(this.heading - prevHeading)
    this.lateralSpeed -= this.speed * Math.sin(dh)
    this.speed *= Math.cos(dh)
    // Fricción lateral limitada por el agarre.
    const maxLatChange = grip * gravity * dt
    if (Math.abs(this.lateralSpeed) <= maxLatChange) {
      this.lateralSpeed = 0
    } else {
      this.lateralSpeed -= Math.sign(this.lateralSpeed) * maxLatChange
      // Derrapando se pierde algo de velocidad (arrastre de las cubiertas).
      this.speed = Math.max(0, this.speed - 0.35 * maxLatChange)
    }

    const fx = Math.cos(this.heading)
    const fy = Math.sin(this.heading)
    this.x += (fx * this.speed - fy * this.lateralSpeed) * dt
    this.y += (fy * this.speed + fx * this.lateralSpeed) * dt

    // Posición en pista.
    this.trackIndex = track.nearestIndex(this.x, this.y, this.trackIndex)
    this.onAsphalt = track.isOnAsphalt(this.x, this.y, this.trackIndex)

    const n = track.points.length
    let delta = this.trackIndex - this.lastIndex
    if (delta > n / 2) delta -= n
    if (delta < -n / 2) delta += n
    const prevProgress = this.progress
    this.progress += delta
    this.lastIndex = this.trackIndex

    // Sectores anti-atajo: hay que pasar por los 3 sectores para que cuente la vuelta.
    this.sectorsHit.add(Math.floor((this.trackIndex / n) * 3))
    const prevCompleted = Math.max(0, Math.floor(prevProgress / n))
    const nowCompleted = Math.max(0, Math.floor(this.progress / n))
    if (nowCompleted > prevCompleted) {
      if (this.sectorsHit.size >= 3) {
        const t = timeNow - this.lapStartTime
        this.lapTimes.push(t)
        this.bestLap = Math.min(this.bestLap, t)
        this.lapStartTime = timeNow
        this.sectorsHit.clear()
      } else {
        this.progress -= n
      }
    }
    this.lap = nowCompleted + 1
  }

  /** Vuelve a poner el auto sobre la línea central, detenido y orientado. */
  resetToTrack(track: Track) {
    const p = track.pointAt(this.trackIndex)
    this.x = p.x
    this.y = p.y
    this.heading = p.heading
    this.speed = 0
    this.lateralSpeed = 0
    this.steerAngle = 0
  }

  get speedKmh() {
    return this.speed * 3.6
  }
}

/**
 * Colisión simple entre autos: círculos que se separan y transfieren
 * velocidad según la componente de choque; el roce continuo apenas frena.
 */
export function resolveCollisions(cars: Car[]) {
  const r = CAR_SPEC.lengthM * 0.36
  for (let i = 0; i < cars.length; i++) {
    for (let j = i + 1; j < cars.length; j++) {
      const a = cars[i]
      const b = cars[j]
      const dx = b.x - a.x
      const dy = b.y - a.y
      const d = Math.hypot(dx, dy)
      const min = r * 2
      if (d > 0 && d < min) {
        const overlap = (min - d) / 2
        const nx = dx / d
        const ny = dy / d
        a.x -= nx * overlap
        a.y -= ny * overlap
        b.x += nx * overlap
        b.y += ny * overlap
        // Velocidad de cierre a lo largo de la normal.
        const vax = Math.cos(a.heading) * a.speed
        const vay = Math.sin(a.heading) * a.speed
        const vbx = Math.cos(b.heading) * b.speed
        const vby = Math.sin(b.heading) * b.speed
        const closing = (vax - vbx) * nx + (vay - vby) * ny
        if (closing > 0) {
          const fa = Math.cos(a.heading) * nx + Math.sin(a.heading) * ny // cuánto empuja a hacia b
          const fb = -(Math.cos(b.heading) * nx + Math.sin(b.heading) * ny)
          a.speed = Math.max(0, a.speed - closing * 0.5 * Math.max(0, fa))
          b.speed = Math.max(0, b.speed - closing * 0.5 * Math.max(0, fb))
          // El empujado gana algo de velocidad si está orientado en ese sentido.
          a.speed += closing * 0.35 * Math.max(0, -fa)
          b.speed += closing * 0.35 * Math.max(0, -fb)
        }
        a.speed *= 0.998
        b.speed *= 0.998
      }
    }
  }
}
