import * as THREE from 'three'

/**
 * Rueda realista hecha por código: cubierta torneada con banda de rodamiento
 * y flancos texturados, llanta de aleación de cinco rayos, tuercas y disco.
 * El eje de giro es Z (la trompa del auto mira a +X).
 */

let tireTex: THREE.CanvasTexture | null = null
let tireBump: THREE.CanvasTexture | null = null
let rimMat: THREE.MeshStandardMaterial | null = null
let barrelMat: THREE.MeshStandardMaterial | null = null
let discMat: THREE.MeshStandardMaterial | null = null

// Distribución de puntos del perfil (índices) para mapear la textura:
// flanco A, banda, flanco B.
const SIDE_PTS = 9
const TREAD_PTS = 9

function makeTireTextures(): { map: THREE.CanvasTexture; bump: THREE.CanvasTexture } {
  const w = 2048
  const h = 512
  const total = SIDE_PTS * 2 + TREAD_PTS - 1
  const vA = (SIDE_PTS - 1) / total // fin del flanco A
  const vB = (SIDE_PTS - 1 + TREAD_PTS - 1) / total // fin de la banda
  const c = document.createElement('canvas')
  c.width = w
  c.height = h
  const ctx = c.getContext('2d')!
  const b = document.createElement('canvas')
  b.width = w
  b.height = h
  const bctx = b.getContext('2d')!

  // Goma base con leve ruido.
  ctx.fillStyle = '#1c1c1c'
  ctx.fillRect(0, 0, w, h)
  const img = ctx.getImageData(0, 0, w, h)
  let seed = 9
  for (let i = 0; i < img.data.length; i += 4) {
    seed = (seed * 1664525 + 1013904223) >>> 0
    const n = ((seed >>> 8) & 0xff) / 255 - 0.5
    img.data[i] += n * 10
    img.data[i + 1] += n * 10
    img.data[i + 2] += n * 10
  }
  ctx.putImageData(img, 0, 0)
  bctx.fillStyle = '#808080'
  bctx.fillRect(0, 0, w, h)

  const yA = vA * h
  const yB = vB * h
  // --- Banda de rodamiento (entre yA e yB) ---
  ctx.fillStyle = '#232323'
  ctx.fillRect(0, yA, w, yB - yA)
  // Canales circunferenciales: dos principales y dos finos.
  const grooves = [0.3, 0.7, 0.12, 0.88]
  grooves.forEach((g, i) => {
    const y = yA + (yB - yA) * g
    const gw = i < 2 ? 14 : 6
    ctx.fillStyle = '#0a0a0a'
    ctx.fillRect(0, y - gw / 2, w, gw)
    bctx.fillStyle = '#202020'
    bctx.fillRect(0, y - gw / 2, w, gw)
  })
  // Surcos laterales curvos, como en la foto, alternados por costilla.
  const pitch = 64
  for (let x = 0; x < w; x += pitch) {
    for (const [y0, y1, dir] of [
      [0.0, 0.3, 1],
      [0.3, 0.7, -1],
      [0.7, 1.0, 1],
    ]) {
      const ya = yA + (yB - yA) * y0
      const yb = yA + (yB - yA) * y1
      for (const target of [ctx, bctx]) {
        target.strokeStyle = target === ctx ? '#0d0d0d' : '#303030'
        target.lineWidth = 7
        target.beginPath()
        target.moveTo(x + 10, ya + 4)
        target.quadraticCurveTo(x + 10 + dir * 22, (ya + yb) / 2, x + 30, yb - 4)
        target.stroke()
      }
    }
  }
  // Pequeños bloques de sipes finos.
  ctx.strokeStyle = '#151515'
  ctx.lineWidth = 2
  for (let x = 32; x < w; x += pitch) {
    ctx.beginPath()
    ctx.moveTo(x, yA + 6)
    ctx.lineTo(x + 6, yB - 6)
    ctx.stroke()
  }

  // --- Flancos: nervaduras concéntricas y letras ---
  const drawSidewall = (y0: number, y1: number, flip: boolean) => {
    // Nervaduras: líneas a lo largo de u (concéntricas en la rueda).
    for (let k = 1; k < 5; k++) {
      const y = y0 + ((y1 - y0) * k) / 5
      ctx.fillStyle = k % 2 ? '#181818' : '#222222'
      ctx.fillRect(0, y - 2, w, 4)
      bctx.fillStyle = k % 2 ? '#6a6a6a' : '#969696'
      bctx.fillRect(0, y - 2, w, 4)
    }
    // Letras de marca dos veces alrededor.
    ctx.save()
    ctx.fillStyle = '#e8e8e8'
    ctx.font = `bold ${Math.round((y1 - y0) * 0.42)}px sans-serif`
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    const ym = (y0 + y1) / 2 + (flip ? 0 : 0)
    for (const x of [w * 0.25, w * 0.75]) {
      ctx.save()
      ctx.translate(x, ym)
      if (flip) ctx.scale(1, -1)
      ctx.fillText('F O R M U L A', 0, 0)
      ctx.restore()
    }
    ctx.font = `${Math.round((y1 - y0) * 0.16)}px sans-serif`
    for (const x of [w * 0.02, w * 0.52]) {
      ctx.save()
      ctx.translate(x + 120, ym + (flip ? -1 : 1) * (y1 - y0) * 0.3)
      if (flip) ctx.scale(1, -1)
      ctx.fillText('185/60 R14 · SPORT 4', 0, 0)
      ctx.restore()
    }
    ctx.restore()
  }
  drawSidewall(0, yA, false)
  drawSidewall(yB, h, true)

  const map = new THREE.CanvasTexture(c)
  map.wrapS = THREE.RepeatWrapping
  map.colorSpace = THREE.SRGBColorSpace
  map.anisotropy = 8
  const bump = new THREE.CanvasTexture(b)
  bump.wrapS = THREE.RepeatWrapping
  bump.anisotropy = 8
  return { map, bump }
}

function ensureMaterials() {
  if (!tireTex) {
    const t = makeTireTextures()
    tireTex = t.map
    tireBump = t.bump
    rimMat = new THREE.MeshStandardMaterial({ color: 0xd9dbe0, metalness: 0.9, roughness: 0.3 })
    barrelMat = new THREE.MeshStandardMaterial({ color: 0x2a2a2a, metalness: 0.7, roughness: 0.5 })
    discMat = new THREE.MeshStandardMaterial({ color: 0x555555, metalness: 0.8, roughness: 0.45 })
  }
}

/**
 * Construye una rueda. `radius` es el radio exterior de la cubierta, `width`
 * el ancho total; la llanta ocupa ~62 % del radio. `side` (+1 derecha, −1
 * izquierda) orienta la cara externa hacia afuera del auto.
 */
export function buildWheel(radius: number, width: number, side: number): THREE.Group {
  ensureMaterials()
  const g = new THREE.Group()
  const rimR = radius * 0.62
  const halfW = width / 2

  // Perfil de la cubierta (radio, z) del flanco interno al externo.
  const pts: THREE.Vector2[] = []
  for (let i = 0; i < SIDE_PTS; i++) {
    const t = i / (SIDE_PTS - 1)
    // Del talón (rimR, -halfW*0.8) al hombro (radius*0.97, -halfW) con panza.
    const r = rimR + (radius * 0.96 - rimR) * Math.sin((t * Math.PI) / 2)
    const z = -halfW * (0.86 + 0.14 * Math.sin((t * Math.PI) / 2))
    pts.push(new THREE.Vector2(r, z))
  }
  for (let i = 1; i < TREAD_PTS; i++) {
    const t = i / (TREAD_PTS - 1)
    // Banda con leve curvatura (más alta en el centro).
    const r = radius * (0.985 + 0.015 * Math.sin(t * Math.PI))
    pts.push(new THREE.Vector2(r, -halfW + width * t))
  }
  for (let i = 1; i < SIDE_PTS; i++) {
    const t = i / (SIDE_PTS - 1)
    const r = radius * 0.96 - (radius * 0.96 - rimR) * Math.sin((t * Math.PI) / 2)
    const z = halfW * (1 - 0.14 * Math.sin((t * Math.PI) / 2))
    pts.push(new THREE.Vector2(r, z))
  }
  const tireGeo = new THREE.LatheGeometry(pts, 56)
  // LatheGeometry gira alrededor de Y: pasar el eje a Z.
  tireGeo.rotateX(Math.PI / 2)
  const tire = new THREE.Mesh(
    tireGeo,
    new THREE.MeshStandardMaterial({ map: tireTex!, bumpMap: tireBump!, bumpScale: 0.6, roughness: 0.92, metalness: 0 }),
  )
  tire.castShadow = true
  g.add(tire)

  // Barril de la llanta (interior de la cubierta).
  const barrel = new THREE.Mesh(new THREE.CylinderGeometry(rimR * 0.98, rimR * 0.98, width * 0.8, 32, 1, true), barrelMat!)
  barrel.geometry.rotateX(Math.PI / 2)
  ;(barrel.material as THREE.MeshStandardMaterial).side = THREE.DoubleSide
  g.add(barrel)

  // Cara externa de la llanta: aro, cinco rayos, cubo y tuercas. Va hacia el lado `side`.
  const face = new THREE.Group()
  const faceZ = side * width * 0.36
  const ring = new THREE.Mesh(new THREE.TorusGeometry(rimR * 0.93, rimR * 0.07, 10, 40), rimMat!)
  ring.position.z = faceZ
  face.add(ring)
  const hub = new THREE.Mesh(new THREE.CylinderGeometry(rimR * 0.34, rimR * 0.34, width * 0.22, 24), rimMat!)
  hub.geometry.rotateX(Math.PI / 2)
  hub.position.z = faceZ
  face.add(hub)
  const spokeLen = rimR * 0.95 - rimR * 0.3
  for (let k = 0; k < 5; k++) {
    const a = (k / 5) * Math.PI * 2
    const spoke = new THREE.Mesh(new THREE.BoxGeometry(spokeLen, rimR * 0.22, width * 0.16), rimMat!)
    spoke.position.set(Math.cos(a) * (rimR * 0.3 + spokeLen / 2), Math.sin(a) * (rimR * 0.3 + spokeLen / 2), faceZ)
    spoke.rotation.z = a
    face.add(spoke)
  }
  for (let k = 0; k < 5; k++) {
    const a = (k / 5) * Math.PI * 2 + Math.PI / 5
    const nut = new THREE.Mesh(new THREE.CylinderGeometry(rimR * 0.05, rimR * 0.05, width * 0.08, 6), barrelMat!)
    nut.geometry.rotateX(Math.PI / 2)
    nut.position.set(Math.cos(a) * rimR * 0.2, Math.sin(a) * rimR * 0.2, faceZ + side * width * 0.13)
    face.add(nut)
  }
  const cap = new THREE.Mesh(new THREE.CylinderGeometry(rimR * 0.1, rimR * 0.1, width * 0.06, 16), barrelMat!)
  cap.geometry.rotateX(Math.PI / 2)
  cap.position.z = faceZ + side * width * 0.13
  face.add(cap)
  g.add(face)

  // Disco de freno del lado interno, visible entre los rayos.
  const disc = new THREE.Mesh(new THREE.CylinderGeometry(rimR * 0.8, rimR * 0.8, 0.02, 32), discMat!)
  disc.geometry.rotateX(Math.PI / 2)
  disc.position.z = -side * width * 0.05
  g.add(disc)

  return g
}
