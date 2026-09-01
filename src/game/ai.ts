import { CAR_SPEC, type Car, type Controls } from './car'
import { Track, wrapAngle } from './track'

/**
 * IA sencilla: apunta a un punto adelante sobre la línea central (con un
 * corrimiento lateral propio de cada auto) y regula la velocidad según la
 * curvatura que viene.
 */
export function aiControls(car: Car, track: Track, others: Car[], lateralBias: number): Controls {
  const v = car.speed
  const lookAhead = 8 + v * 0.55
  const target = track.pointAt(car.trackIndex + Math.round(lookAhead))
  const nx = -Math.sin(target.heading)
  const ny = Math.cos(target.heading)
  const tx = target.x + nx * lateralBias
  const ty = target.y + ny * lateralBias

  const desired = Math.atan2(ty - car.y, tx - car.x)
  const err = wrapAngle(desired - car.heading)
  let steer = Math.max(-1, Math.min(1, err * 2.2 + car.lateralSpeed * 0.04))

  // Velocidad objetivo en función de la curvatura próxima.
  const grip = CAR_SPEC.gripTrack * 9.81 * (0.78 + car.skill * 0.2)
  const brakingDist = 12 + (v * v) / (2 * CAR_SPEC.brakeDecel * 0.8)
  let targetSpeed = 70
  for (let d = 4; d <= brakingDist; d += 4) {
    const k = Math.abs(track.pointAt(car.trackIndex + d).curvature)
    if (k > 1e-4) {
      const vCorner = Math.sqrt(grip / k)
      // Velocidad a la que llegamos si frenamos desde ahora hasta la curva.
      const vAllowed = Math.sqrt(vCorner * vCorner + 2 * CAR_SPEC.brakeDecel * 0.8 * d)
      targetSpeed = Math.min(targetSpeed, vAllowed)
    }
  }

  // Evitar chocar al de adelante.
  for (const o of others) {
    if (o === car) continue
    const dx = o.x - car.x
    const dy = o.y - car.y
    const fwd = dx * Math.cos(car.heading) + dy * Math.sin(car.heading)
    const side = -dx * Math.sin(car.heading) + dy * Math.cos(car.heading)
    if (fwd > 0 && fwd < 10 + v * 0.4 && Math.abs(side) < 2.6) {
      // Seguir al de adelante sin chocarlo; si es mucho más lento, buscar el costado.
      if (o.speed < car.speed) targetSpeed = Math.min(targetSpeed, o.speed + Math.max(0, fwd - 5) * 0.4)
      if (o.speed < car.speed - 3) steer += side > 0 ? -0.2 : 0.2
    }
  }

  let throttle = 0
  let brake = 0
  if (v < targetSpeed - 0.5) throttle = 1
  else if (v > targetSpeed + 1.5) brake = Math.min(1, (v - targetSpeed) / 6 + 0.3)
  if (!car.onAsphalt) throttle = Math.min(throttle, 0.6)

  return { throttle, brake, steer: Math.max(-1, Math.min(1, steer)) }
}
