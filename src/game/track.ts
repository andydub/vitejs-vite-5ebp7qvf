// Trazado del Autódromo Municipal "Víctor García" (General Alvear, Mendoza).
// Los puntos de control son una aproximación: se escalan para que el
// desarrollo total sea de 1400 m. Ajustar con fotos/plano real.

export interface Vec2 {
  x: number
  y: number
}

export interface TrackPoint extends Vec2 {
  s: number // distancia acumulada desde la largada (m)
  heading: number // rad
  curvature: number // 1/m (signo: + gira a la derecha en coords y-abajo)
}

export const TRACK_LENGTH_M = 1400
export const TRACK_WIDTH_M = 11

/** Perfil transversal de las bermas (offset desde el borde de pista, altura). Ambos lados. */
export const BERM_PROFILE: { off: number; y: number }[] = [
  { off: -0.2, y: 0.03 },
  { off: 1.6, y: 0.42 },
  { off: 3.2, y: 0.28 },
  { off: 6, y: 0 },
]
/** Perfil del terraplén del público (solo del lado exterior). */
export const EMBANKMENT_PROFILE: { off: number; y: number }[] = [
  { off: 10, y: 0 },
  { off: 14, y: 1.3 },
  { off: 30, y: 1.3 },
  { off: 35, y: 0 },
]
export const TRACK_SURFACE_Y = 0.04

// Puntos de control calcados de la imagen satelital (píxeles de la captura,
// origen arriba a la izquierda; ~0,47 m por píxel). El trazado se escala
// después para que el desarrollo total sea de 1400 m. Sentido horario visto
// desde arriba: la largada está en la recta del este, bajando hacia el sur.
const SAT_PX_PER_M = 1 / 0.47
const SAT_CENTER = { x: 550, y: 850 }
const SAT_POINTS: Vec2[] = [
  { x: 820, y: 760 }, // largada
  { x: 885, y: 990 },
  { x: 870, y: 1150 },
  { x: 790, y: 1270 },
  { x: 640, y: 1350 },
  { x: 450, y: 1390 },
  { x: 290, y: 1350 },
  { x: 185, y: 1230 },
  { x: 170, y: 1100 },
  { x: 215, y: 1000 },
  { x: 290, y: 910 },
  { x: 370, y: 860 },
  { x: 480, y: 850 },
  { x: 590, y: 858 },
  { x: 645, y: 830 },
  { x: 625, y: 730 },
  { x: 570, y: 620 },
  { x: 510, y: 500 },
  { x: 500, y: 400 },
  { x: 545, y: 320 },
  { x: 630, y: 320 },
  { x: 690, y: 400 },
  { x: 715, y: 500 },
  { x: 760, y: 610 },
]
const CONTROL_POINTS: Vec2[] = SAT_POINTS.map((p) => ({
  x: (p.x - SAT_CENTER.x) / SAT_PX_PER_M,
  y: (p.y - SAT_CENTER.y) / SAT_PX_PER_M,
}))

function catmullRom(p0: Vec2, p1: Vec2, p2: Vec2, p3: Vec2, t: number): Vec2 {
  const t2 = t * t
  const t3 = t2 * t
  return {
    x:
      0.5 *
      (2 * p1.x +
        (-p0.x + p2.x) * t +
        (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2 +
        (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3),
    y:
      0.5 *
      (2 * p1.y +
        (-p0.y + p2.y) * t +
        (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * t2 +
        (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * t3),
  }
}

function buildPolyline(points: Vec2[], samplesPerSegment: number): Vec2[] {
  const n = points.length
  const out: Vec2[] = []
  for (let i = 0; i < n; i++) {
    const p0 = points[(i - 1 + n) % n]
    const p1 = points[i]
    const p2 = points[(i + 1) % n]
    const p3 = points[(i + 2) % n]
    for (let k = 0; k < samplesPerSegment; k++) {
      out.push(catmullRom(p0, p1, p2, p3, k / samplesPerSegment))
    }
  }
  return out
}

function polylineLength(pts: Vec2[]): number {
  let len = 0
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i]
    const b = pts[(i + 1) % pts.length]
    len += Math.hypot(b.x - a.x, b.y - a.y)
  }
  return len
}

export function wrapAngle(a: number): number {
  while (a > Math.PI) a -= 2 * Math.PI
  while (a < -Math.PI) a += 2 * Math.PI
  return a
}

export class Track {
  readonly points: TrackPoint[]
  readonly length: number
  readonly width = TRACK_WIDTH_M
  readonly bounds: { minX: number; minY: number; maxX: number; maxY: number }
  private readonly cellSize = 20
  private readonly grid = new Map<string, number[]>()

  constructor() {
    const raw = buildPolyline(CONTROL_POINTS, 24)
    const rawLen = polylineLength(raw)
    const scale = TRACK_LENGTH_M / rawLen
    const scaled = raw.map((p) => ({ x: p.x * scale, y: p.y * scale }))

    // Re-muestrear a paso constante (~1 m) para tener s uniforme.
    const step = 1
    const resampled: Vec2[] = []
    let carry = 0
    for (let i = 0; i < scaled.length; i++) {
      const a = scaled[i]
      const b = scaled[(i + 1) % scaled.length]
      const segLen = Math.hypot(b.x - a.x, b.y - a.y)
      let d = carry
      while (d < segLen) {
        const t = d / segLen
        resampled.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t })
        d += step
      }
      carry = d - segLen
    }

    const n = resampled.length
    this.points = resampled.map((p, i) => {
      const prev = resampled[(i - 1 + n) % n]
      const next = resampled[(i + 1) % n]
      const heading = Math.atan2(next.y - prev.y, next.x - prev.x)
      return { x: p.x, y: p.y, s: i * step, heading, curvature: 0 }
    })
    for (let i = 0; i < n; i++) {
      const h0 = this.points[(i - 2 + n) % n].heading
      const h1 = this.points[(i + 2) % n].heading
      this.points[i].curvature = wrapAngle(h1 - h0) / (4 * step)
    }
    this.length = n * step

    let minX = Infinity
    let minY = Infinity
    let maxX = -Infinity
    let maxY = -Infinity
    for (const p of this.points) {
      minX = Math.min(minX, p.x)
      minY = Math.min(minY, p.y)
      maxX = Math.max(maxX, p.x)
      maxY = Math.max(maxY, p.y)
    }
    const pad = 60
    this.bounds = { minX: minX - pad, minY: minY - pad, maxX: maxX + pad, maxY: maxY + pad }

    for (let i = 0; i < n; i++) {
      const key = this.cellKey(this.points[i].x, this.points[i].y)
      const list = this.grid.get(key)
      if (list) list.push(i)
      else this.grid.set(key, [i])
    }
  }

  private cellKey(x: number, y: number): string {
    return `${Math.floor(x / this.cellSize)},${Math.floor(y / this.cellSize)}`
  }

  /** Índice del punto de la línea central más cercano a (x, y). */
  nearestIndex(x: number, y: number, hintIndex?: number): number {
    // Búsqueda local alrededor del hint (barata y estable para autos en pista).
    if (hintIndex !== undefined) {
      const n = this.points.length
      let best = hintIndex
      let bestD = Infinity
      for (let k = -40; k <= 40; k++) {
        const i = (hintIndex + k + n) % n
        const p = this.points[i]
        const d = (p.x - x) ** 2 + (p.y - y) ** 2
        if (d < bestD) {
          bestD = d
          best = i
        }
      }
      if (bestD < (this.width * 3) ** 2) return best
    }
    // Búsqueda por grilla si no hay hint o el auto se fue lejos.
    const cx = Math.floor(x / this.cellSize)
    const cy = Math.floor(y / this.cellSize)
    let best = -1
    let bestD = Infinity
    for (let r = 0; r <= 6 && best === -1; r++) {
      for (let dx = -r; dx <= r; dx++) {
        for (let dy = -r; dy <= r; dy++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue
          const list = this.grid.get(`${cx + dx},${cy + dy}`)
          if (!list) continue
          for (const i of list) {
            const p = this.points[i]
            const d = (p.x - x) ** 2 + (p.y - y) ** 2
            if (d < bestD) {
              bestD = d
              best = i
            }
          }
        }
      }
    }
    if (best === -1) {
      // Fallback lineal (muy raro).
      for (let i = 0; i < this.points.length; i++) {
        const p = this.points[i]
        const d = (p.x - x) ** 2 + (p.y - y) ** 2
        if (d < bestD) {
          bestD = d
          best = i
        }
      }
    }
    return best
  }

  pointAt(index: number): TrackPoint {
    const n = this.points.length
    return this.points[((index % n) + n) % n]
  }

  /** Punto interpolado para un índice fraccionario (para cámaras suaves). */
  pointAtF(index: number): { x: number; y: number; heading: number } {
    const i0 = Math.floor(index)
    const t = index - i0
    const a = this.pointAt(i0)
    const b = this.pointAt(i0 + 1)
    return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, heading: a.heading + wrapAngle(b.heading - a.heading) * t }
  }

  pointAtDistance(s: number): TrackPoint {
    return this.pointAt(Math.round(s))
  }

  /** Distancia lateral con signo respecto de la línea central. */
  lateralOffset(x: number, y: number, index: number): number {
    const p = this.points[index]
    const nx = -Math.sin(p.heading)
    const ny = Math.cos(p.heading)
    return (x - p.x) * nx + (y - p.y) * ny
  }

  isOnAsphalt(x: number, y: number, index: number): boolean {
    return Math.abs(this.lateralOffset(x, y, index)) <= this.width / 2
  }

  /** +1 si el lado positivo de la normal en ese punto mira hacia afuera del circuito. */
  outwardAt(index: number): number {
    const p = this.pointAt(index)
    const cxm = (this.bounds.minX + this.bounds.maxX) / 2
    const cym = (this.bounds.minY + this.bounds.maxY) / 2
    const nx = -Math.sin(p.heading)
    const ny = Math.cos(p.heading)
    return (p.x - cxm) * nx + (p.y - cym) * ny > 0 ? 1 : -1
  }

  /**
   * Altura del terreno en un punto: superficie de pista, bermas de tierra
   * suelta a los costados y terraplén del público del lado exterior.
   */
  groundHeight(x: number, y: number, hintIndex?: number): number {
    const idx = this.nearestIndex(x, y, hintIndex)
    const lat = this.lateralOffset(x, y, idx)
    const d = Math.abs(lat) - this.width / 2
    if (d <= BERM_PROFILE[0].off) return TRACK_SURFACE_Y
    const outward = Math.sign(lat) === this.outwardAt(idx)
    const profiles = outward ? [BERM_PROFILE, EMBANKMENT_PROFILE] : [BERM_PROFILE]
    for (const prof of profiles) {
      for (let i = 0; i < prof.length - 1; i++) {
        const a = prof[i]
        const b = prof[i + 1]
        if (d >= a.off && d <= b.off) {
          const t = (d - a.off) / (b.off - a.off)
          return a.y + (b.y - a.y) * t
        }
      }
    }
    return 0
  }

  /** Curvatura máxima absoluta en un tramo hacia adelante. */
  maxCurvatureAhead(index: number, meters: number): number {
    let m = 0
    for (let d = 0; d <= meters; d += 2) {
      m = Math.max(m, Math.abs(this.pointAt(index + d).curvature))
    }
    return m
  }
}
