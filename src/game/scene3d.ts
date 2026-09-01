import * as THREE from 'three'
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js'
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js'
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js'
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js'
import { SMAAPass } from 'three/addons/postprocessing/SMAAPass.js'
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js'
import { Lensflare, LensflareElement } from 'three/addons/objects/Lensflare.js'
import { CAR_SPEC, type Car } from './car'
import { Track } from './track'
import { applyHueShift, loadCarModel } from './models'

// Convención: el mundo del juego es (x, y) en planta; en Three.js va a (x, 0, y).
// Un rumbo θ (cos θ, sin θ) equivale a rotation.y = -θ con el auto mirando +X.

// ---------------------------------------------------------------------------
// Utilidades de ruido y texturas generadas por código
// ---------------------------------------------------------------------------

function makeRng(seed: number) {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 4294967296
  }
}

/** Ruido de valor suavizado, varias octavas, en [0,1]. */
function makeNoise2D(seed: number) {
  const rnd = makeRng(seed)
  const size = 256
  const grid = new Float32Array(size * size)
  for (let i = 0; i < grid.length; i++) grid[i] = rnd()
  const sample = (x: number, y: number) => {
    const x0 = Math.floor(x)
    const y0 = Math.floor(y)
    const tx = x - x0
    const ty = y - y0
    const sx = tx * tx * (3 - 2 * tx)
    const sy = ty * ty * (3 - 2 * ty)
    const g = (ix: number, iy: number) => grid[((iy % size) + size) % size * size + (((ix % size) + size) % size)]
    const a = g(x0, y0)
    const b = g(x0 + 1, y0)
    const c = g(x0, y0 + 1)
    const d = g(x0 + 1, y0 + 1)
    return (a * (1 - sx) + b * sx) * (1 - sy) + (c * (1 - sx) + d * sx) * sy
  }
  return (x: number, y: number, octaves = 4) => {
    let v = 0
    let amp = 0.5
    let f = 1
    for (let o = 0; o < octaves; o++) {
      v += sample(x * f, y * f) * amp
      amp *= 0.5
      f *= 2
    }
    return v
  }
}

function canvasTexture(canvas: HTMLCanvasElement, repeat = true): THREE.CanvasTexture {
  const tex = new THREE.CanvasTexture(canvas)
  if (repeat) tex.wrapS = tex.wrapT = THREE.RepeatWrapping
  tex.colorSpace = THREE.SRGBColorSpace
  tex.anisotropy = 8
  return tex
}

/** Textura de la pista: tierra compactada clara con huellas y bordes sueltos. U cruza la pista, V va a lo largo. */
function makeTrackTexture(): THREE.CanvasTexture {
  const w = 256
  const h = 1024
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')!
  const img = ctx.createImageData(w, h)
  const noise = makeNoise2D(7)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const u = x / w
      const n = noise(x / 40, y / 40, 4)
      const fine = noise(x / 6, y / 6, 2)
      // Huellas: dos bandas oscuras donde pasan las ruedas, con ondulación.
      const wobble = Math.sin(y / 90) * 0.04
      const rut = Math.exp(-(((u - 0.32 - wobble) / 0.07) ** 2)) + Math.exp(-(((u - 0.68 + wobble) / 0.07) ** 2))
      // Bordes: tierra suelta más oscura y rugosa.
      const edge = Math.max(0, 1 - Math.min(u, 1 - u) / 0.1)
      let k = 0.95 + (n - 0.5) * 0.3 + (fine - 0.5) * 0.14 - rut * 0.24 - edge * 0.28
      // Estrías longitudinales finas.
      k += 0.03 * Math.sin(x * 1.3 + Math.sin(y * 0.05) * 3)
      const r = 198 * k
      const g = 178 * k
      const b = 146 * k
      const i = (y * w + x) * 4
      img.data[i] = Math.min(255, r)
      img.data[i + 1] = Math.min(255, g)
      img.data[i + 2] = Math.min(255, b)
      img.data[i + 3] = 255
    }
  }
  ctx.putImageData(img, 0, 0)
  return canvasTexture(canvas)
}

/** Textura de la tierra suelta de las bermas. */
function makeLooseDirtTexture(): THREE.CanvasTexture {
  const size = 256
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d')!
  const img = ctx.createImageData(size, size)
  const noise = makeNoise2D(11)
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const n = noise(x / 24, y / 24, 4)
      const k = 0.8 + (n - 0.5) * 0.7
      const i = (y * size + x) * 4
      img.data[i] = Math.min(255, 132 * k)
      img.data[i + 1] = Math.min(255, 100 * k)
      img.data[i + 2] = Math.min(255, 70 * k)
      img.data[i + 3] = 255
    }
  }
  ctx.putImageData(img, 0, 0)
  return canvasTexture(canvas)
}

/**
 * Terreno: una sola textura grande pintada en coordenadas de mundo con
 * tierra rojiza, matas de monte, el camino perimetral y el paddock.
 */
function makeGroundTexture(track: Track, size: number, center: THREE.Vector2, groundSize: number, paddock: PaddockInfo): THREE.CanvasTexture {
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d')!
  const toPx = (x: number, y: number): [number, number] => [
    ((x - center.x) / groundSize + 0.5) * size,
    ((y - center.y) / groundSize + 0.5) * size,
  ]
  const mPerPx = groundSize / size

  // Base: tierra rojiza con ruido a gran escala.
  const img = ctx.createImageData(size, size)
  const noise = makeNoise2D(3)
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const n = noise(x / 90, y / 90, 4)
      const fine = noise(x / 9, y / 9, 2)
      const k = 0.9 + (n - 0.5) * 0.35 + (fine - 0.5) * 0.15
      const i = (y * size + x) * 4
      img.data[i] = Math.min(255, 146 * k)
      img.data[i + 1] = Math.min(255, 104 * k)
      img.data[i + 2] = Math.min(255, 70 * k)
      img.data[i + 3] = 255
    }
  }
  ctx.putImageData(img, 0, 0)

  // Matas de monte (jarilla): elipses verde oliva, más densas lejos de la pista.
  const rnd = makeRng(21)
  const half = track.width / 2
  const nearTrack = (x: number, y: number, m: number) => {
    const p = track.points[track.nearestIndex(x, y)]
    return Math.hypot(p.x - x, p.y - y) < half + m
  }
  const inPaddock = (x: number, y: number) => {
    const dx = x - paddock.cx
    const dy = y - paddock.cy
    const a = dx * paddock.ax + dy * paddock.ay
    const b = -dx * paddock.ay + dy * paddock.ax
    return Math.abs(a) < paddock.halfLen + 10 && Math.abs(b) < paddock.halfWid + 10
  }
  for (let k = 0; k < 9000; k++) {
    const x = center.x + (rnd() - 0.5) * groundSize
    const y = center.y + (rnd() - 0.5) * groundSize
    if (nearTrack(x, y, 34) || inPaddock(x, y)) continue
    const [px, py] = toPx(x, y)
    const r = (2 + rnd() * 9) / mPerPx
    const g = 96 + rnd() * 30
    ctx.fillStyle = `rgba(${70 + rnd() * 20}, ${g}, ${40 + rnd() * 20}, ${0.55 + rnd() * 0.4})`
    ctx.beginPath()
    ctx.ellipse(px, py, r, r * (0.6 + rnd() * 0.6), rnd() * Math.PI, 0, Math.PI * 2)
    ctx.fill()
  }

  // Camino perimetral (terraplén donde estaciona la gente): franja clara.
  ctx.strokeStyle = 'rgba(205, 180, 138, 0.9)'
  ctx.lineWidth = 16 / mPerPx
  ctx.lineJoin = 'round'
  ctx.beginPath()
  const cxm = center.x
  const cym = center.y
  track.points.forEach((p, i) => {
    const nx = -Math.sin(p.heading)
    const ny = Math.cos(p.heading)
    const outward = (p.x - cxm) * nx + (p.y - cym) * ny > 0 ? 1 : -1
    const off = half + 22
    const [px, py] = toPx(p.x + nx * off * outward, p.y + ny * off * outward)
    if (i === 0) ctx.moveTo(px, py)
    else ctx.lineTo(px, py)
  })
  ctx.closePath()
  ctx.stroke()

  // Paddock: explanada de tierra pisada.
  ctx.save()
  const [pcx, pcy] = toPx(paddock.cx, paddock.cy)
  ctx.translate(pcx, pcy)
  ctx.rotate(Math.atan2(paddock.ay, paddock.ax))
  ctx.fillStyle = 'rgba(200, 172, 128, 0.85)'
  ctx.fillRect(-paddock.halfLen / mPerPx, -paddock.halfWid / mPerPx, (paddock.halfLen * 2) / mPerPx, (paddock.halfWid * 2) / mPerPx)
  ctx.restore()

  // Huellas de vehículos en el campo alrededor (caminos de acceso).
  ctx.strokeStyle = 'rgba(190, 160, 120, 0.5)'
  ctx.lineWidth = 4 / mPerPx
  for (let k = 0; k < 6; k++) {
    ctx.beginPath()
    const [sx, sy] = toPx(paddock.cx + paddock.ay * (paddock.halfWid + 5) * (k % 2 ? 1 : -1), paddock.cy - paddock.ax * (paddock.halfWid + 5) * (k % 2 ? 1 : -1))
    ctx.moveTo(sx, sy)
    const ang = rnd() * Math.PI * 2
    ctx.quadraticCurveTo(sx + Math.cos(ang) * 300, sy + Math.sin(ang) * 300, sx + Math.cos(ang + 0.5) * 900, sy + Math.sin(ang + 0.5) * 900)
    ctx.stroke()
  }

  return canvasTexture(canvas, false)
}

function makeSoftTexture(inner: string, outer: string): THREE.CanvasTexture {
  const c = document.createElement('canvas')
  c.width = c.height = 128
  const ctx = c.getContext('2d')!
  const g = ctx.createRadialGradient(64, 64, 0, 64, 64, 64)
  g.addColorStop(0, inner)
  g.addColorStop(1, outer)
  ctx.fillStyle = g
  ctx.fillRect(0, 0, 128, 128)
  return new THREE.CanvasTexture(c)
}

function makeCloudTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas')
  c.width = 256
  c.height = 128
  const ctx = c.getContext('2d')!
  const rnd = makeRng(5)
  for (let k = 0; k < 26; k++) {
    const x = 40 + rnd() * 176
    const y = 40 + rnd() * 50
    const r = 18 + rnd() * 30
    const g = ctx.createRadialGradient(x, y, 0, x, y, r)
    g.addColorStop(0, 'rgba(255,255,255,0.55)')
    g.addColorStop(1, 'rgba(255,255,255,0)')
    ctx.fillStyle = g
    ctx.fillRect(x - r, y - r, r * 2, r * 2)
  }
  const tex = new THREE.CanvasTexture(c)
  tex.colorSpace = THREE.SRGBColorSpace
  return tex
}

function makeNumberTexture(num: number, color: string): THREE.CanvasTexture {
  const canvas = document.createElement('canvas')
  canvas.width = 256
  canvas.height = 256
  const ctx = canvas.getContext('2d')!
  ctx.fillStyle = color
  ctx.fillRect(0, 0, 256, 256)
  ctx.globalAlpha = 0.3
  ctx.fillStyle = '#ffffff'
  for (let i = -3; i < 6; i++) {
    ctx.beginPath()
    ctx.moveTo(i * 60, 256)
    ctx.lineTo(i * 60 + 120, 0)
    ctx.lineTo(i * 60 + 140, 0)
    ctx.lineTo(i * 60 + 20, 256)
    ctx.fill()
  }
  ctx.globalAlpha = 1
  ctx.fillStyle = '#ffffff'
  ctx.font = 'bold 170px sans-serif'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.lineWidth = 14
  ctx.strokeStyle = '#111'
  ctx.strokeText(String(num), 128, 140)
  ctx.fillText(String(num), 128, 140)
  return canvasTexture(canvas, false)
}

const SPONSORS = ['YPF', 'AUTOMOTORES', 'LUBRICENTRO', 'NEUMÁTICOS', 'TALLER', 'CARROCERÍAS', 'AGRO', 'TRANSPORTES']

/** Panel lateral: franjas del color de la jaula, número grande y sponsors, como en la categoría. */
function makeSideTexture(num: number, team: string, color: string, stripe: string): THREE.CanvasTexture {
  const canvas = document.createElement('canvas')
  canvas.width = 1024
  canvas.height = 256
  const ctx = canvas.getContext('2d')!
  ctx.fillStyle = color
  ctx.fillRect(0, 0, 1024, 256)
  // Franjas diagonales del color secundario.
  ctx.fillStyle = stripe
  ctx.globalAlpha = 0.85
  for (let i = 0; i < 3; i++) {
    ctx.beginPath()
    ctx.moveTo(560 + i * 70, 256)
    ctx.lineTo(680 + i * 70, 0)
    ctx.lineTo(705 + i * 70, 0)
    ctx.lineTo(585 + i * 70, 256)
    ctx.fill()
  }
  ctx.globalAlpha = 1
  // Banda blanca con el equipo.
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(250, 60, 300, 130)
  ctx.fillStyle = '#111'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.font = 'bold 44px sans-serif'
  ctx.fillText(team.toUpperCase(), 400, 100)
  ctx.font = 'bold 30px sans-serif'
  ctx.fillStyle = '#1f5fd6'
  ctx.fillText(SPONSORS[num % SPONSORS.length], 400, 155)
  // Sponsors chicos en la trompa.
  ctx.fillStyle = '#ffffff'
  ctx.font = 'bold 34px sans-serif'
  ctx.fillText(SPONSORS[(num * 3 + 1) % SPONSORS.length], 850, 100)
  ctx.font = '26px sans-serif'
  ctx.fillText(SPONSORS[(num * 5 + 2) % SPONSORS.length], 850, 160)
  // Número grande.
  ctx.font = 'bold 170px sans-serif'
  ctx.fillStyle = '#fff'
  ctx.lineWidth = 12
  ctx.strokeStyle = '#111'
  ctx.strokeText(String(num), 125, 132)
  ctx.fillText(String(num), 125, 132)
  return canvasTexture(canvas, false)
}

/** Rejilla del radiador. */
function makeGrilleTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas')
  c.width = 64
  c.height = 64
  const ctx = c.getContext('2d')!
  ctx.fillStyle = '#0b0b0b'
  ctx.fillRect(0, 0, 64, 64)
  ctx.fillStyle = '#3a3a3a'
  for (let y = 2; y < 64; y += 6) ctx.fillRect(0, y, 64, 2)
  return canvasTexture(c)
}

// ---------------------------------------------------------------------------
// Auto
// ---------------------------------------------------------------------------

const wheelGeo = new THREE.CylinderGeometry(0.3, 0.3, 0.22, 18)
wheelGeo.rotateX(Math.PI / 2)
const rearWheelGeo = new THREE.CylinderGeometry(0.42, 0.42, 0.4, 18)
rearWheelGeo.rotateX(Math.PI / 2)
const hubGeo = new THREE.CylinderGeometry(0.15, 0.15, 0.24, 12)
hubGeo.rotateX(Math.PI / 2)
const rimGeo = new THREE.CylinderGeometry(0.3, 0.3, 0.42, 16)
rimGeo.rotateX(Math.PI / 2)
const rubberMat = new THREE.MeshStandardMaterial({ color: 0x1a1a1a, roughness: 0.95 })
const hubMat = new THREE.MeshStandardMaterial({ color: 0xbfbfbf, roughness: 0.4, metalness: 0.6 })
const cageMat = new THREE.MeshStandardMaterial({ color: 0x222222, roughness: 0.6, metalness: 0.4 })
const bumperMat = new THREE.MeshStandardMaterial({ color: 0xe8e8e8, roughness: 0.5, metalness: 0.3 })
const glassMat = new THREE.MeshStandardMaterial({ color: 0x334455, roughness: 0.1, metalness: 0.3 })
const netMat = new THREE.MeshStandardMaterial({ color: 0x111111, transparent: true, opacity: 0.45, side: THREE.DoubleSide })
const aluMat = new THREE.MeshStandardMaterial({ color: 0xd8d8d8, roughness: 0.35, metalness: 0.8 })
const suitMat = new THREE.MeshStandardMaterial({ color: 0x1d3f8f, roughness: 0.9 })
const springMat = new THREE.MeshStandardMaterial({ color: 0xe0b000, roughness: 0.5, metalness: 0.3 })
const spokeGeo = new THREE.BoxGeometry(0.05, 0.26, 0.06)
let contactShadowTex: THREE.CanvasTexture | null = null
let grilleTex: THREE.CanvasTexture | null = null

interface CarView {
  group: THREE.Group
  body: THREE.Group
  frontWheels: THREE.Object3D[]
  wheels: THREE.Mesh[]
  dust: THREE.Sprite[]
  dustAge: number[]
  dustNext: number
  markDist: number
  markIndex: number
}

/**
 * Auto Sport 4 según las fotos: cuña baja con motor adelante y toma de aire
 * asomando del capot, ruedas delanteras chicas y descubiertas, traseras más
 * grandes con llanta plateada, jaula con red en la ventana sobre el eje
 * trasero, placa con el número atrás y paragolpes trasero de caño.
 */
function buildCar(car: Car): CarView {
  const group = new THREE.Group()
  const body = new THREE.Group()
  group.add(body)
  const L = CAR_SPEC.lengthM
  const W = CAR_SPEC.widthM
  const paint = new THREE.MeshPhysicalMaterial({ color: car.color, roughness: 0.3, metalness: 0.25, clearcoat: 0.8, clearcoatRoughness: 0.15 })
  const trim = new THREE.MeshStandardMaterial({ color: car.cageColor, roughness: 0.45, metalness: 0.5 })
  const numTex = makeNumberTexture(car.number, car.color)
  const decalMat = new THREE.MeshStandardMaterial({ map: numTex, roughness: 0.4, side: THREE.DoubleSide })
  const roofTex = makeNumberTexture(car.number, car.color)
  roofTex.center.set(0.5, 0.5)
  roofTex.rotation = -Math.PI / 2
  const roofMat = new THREE.MeshStandardMaterial({ map: roofTex, roughness: 0.4 })
  const sideMat = new THREE.MeshPhysicalMaterial({ map: makeSideTexture(car.number, car.name, car.color, car.cageColor), roughness: 0.3, clearcoat: 0.6 })

  // Cuerpo: cuña que baja hacia la trompa (perfil lateral extruido a lo ancho).
  const profile = new THREE.Shape()
  profile.moveTo(-L * 0.45, 0.2)
  profile.lineTo(L * 0.5, 0.24)
  profile.lineTo(L * 0.5, 0.34)
  profile.lineTo(L * 0.1, 0.58)
  profile.lineTo(-L * 0.45, 0.66)
  const bodyGeo = new THREE.ExtrudeGeometry(profile, { depth: W * 0.6, bevelEnabled: false })
  bodyGeo.translate(0, 0, -W * 0.3)
  const bodyMesh = new THREE.Mesh(bodyGeo, paint)
  bodyMesh.castShadow = true
  body.add(bodyMesh)

  // Motor: toma de aire con trompetas asomando del capot.
  const intake = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.18, 0.5), cageMat)
  intake.position.set(L * 0.12, 0.62, 0.05)
  body.add(intake)
  const trumpet = new THREE.CylinderGeometry(0.05, 0.035, 0.16, 8)
  for (let i = 0; i < 4; i++) {
    const t = new THREE.Mesh(trumpet, hubMat)
    t.position.set(L * 0.12 - 0.18 + i * 0.12, 0.78, 0.05)
    body.add(t)
  }
  // Escapes 4 en 1: cuatro tubos que salen del lateral y se juntan en un colector.
  const header = new THREE.CylinderGeometry(0.03, 0.03, 0.45, 8)
  for (let i = 0; i < 4; i++) {
    const h = new THREE.Mesh(header, aluMat)
    h.rotation.x = Math.PI / 2
    h.rotation.z = 0.25
    h.position.set(L * 0.2 - i * 0.14, 0.42, -W * 0.36)
    body.add(h)
  }
  const collector = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 1.3, 10), aluMat)
  collector.rotation.z = Math.PI / 2
  collector.position.set(-L * 0.12, 0.3, -W * 0.5)
  body.add(collector)
  const muffler = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.09, 0.5, 10), aluMat)
  muffler.rotation.z = Math.PI / 2
  muffler.position.set(-L * 0.42, 0.3, -W * 0.5)
  body.add(muffler)
  // Radiador y aleta en la trompa.
  if (!grilleTex) grilleTex = makeGrilleTexture()
  const grille = new THREE.Mesh(new THREE.PlaneGeometry(W * 0.5, 0.1), new THREE.MeshStandardMaterial({ map: grilleTex, roughness: 0.9 }))
  grille.position.set(L * 0.5 + 0.005, 0.29, 0)
  grille.rotation.y = Math.PI / 2
  body.add(grille)
  const fin = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.16, 0.03), paint)
  fin.position.set(L * 0.36, 0.42, 0)
  body.add(fin)
  // Ranuras de ventilación en los laterales del motor.
  const vent = new THREE.BoxGeometry(0.16, 0.05, 0.01)
  for (const side of [-1, 1]) {
    for (let i = 0; i < 3; i++) {
      const v = new THREE.Mesh(vent, cageMat)
      v.position.set(L * 0.28 - i * 0.22, 0.47 - i * 0.03, side * (W * 0.3 + 0.005))
      body.add(v)
    }
  }
  // Espejos.
  for (const side of [-1, 1]) {
    const stalk = new THREE.Mesh(new THREE.CylinderGeometry(0.015, 0.015, 0.3, 5), cageMat)
    stalk.rotation.x = Math.PI / 2
    stalk.position.set(-L * 0.1, 0.95, side * (W * 0.28 + 0.15))
    body.add(stalk)
    const mirror = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.1, 0.16), cageMat)
    mirror.position.set(-L * 0.1, 0.95, side * (W * 0.28 + 0.32))
    body.add(mirror)
  }

  // Jaula antivuelco sobre el eje trasero.
  const tube = new THREE.CylinderGeometry(0.03, 0.03, 1, 6)
  const addTube = (a: THREE.Vector3, b: THREE.Vector3, mat = trim) => {
    const len = a.distanceTo(b)
    const m = new THREE.Mesh(tube, mat)
    m.scale.y = len
    m.position.copy(a).lerp(b, 0.5)
    m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), b.clone().sub(a).normalize())
    body.add(m)
  }
  const cx0 = -L * 0.44
  const cx1 = -L * 0.12
  const cz = W * 0.28
  const yTop = 1.3
  const yBase = 0.6
  for (const z of [-cz, cz]) {
    addTube(new THREE.Vector3(cx0, yBase, z), new THREE.Vector3(cx0, yTop, z))
    addTube(new THREE.Vector3(cx1, yBase, z), new THREE.Vector3(cx1 + 0.3, yTop, z))
    addTube(new THREE.Vector3(cx0, yTop, z), new THREE.Vector3(cx1 + 0.3, yTop, z))
    addTube(new THREE.Vector3(cx1 + 0.3, yTop, z), new THREE.Vector3(L * 0.1, 0.58, z))
  }
  addTube(new THREE.Vector3(cx0, yTop, -cz), new THREE.Vector3(cx0, yTop, cz))
  addTube(new THREE.Vector3(cx1 + 0.3, yTop, -cz), new THREE.Vector3(cx1 + 0.3, yTop, cz))
  const roof = new THREE.Mesh(new THREE.BoxGeometry(cx1 + 0.3 - cx0 + 0.1, 0.05, cz * 2 + 0.1), roofMat)
  roof.position.set((cx0 + cx1 + 0.3) / 2, yTop + 0.03, 0)
  roof.castShadow = true
  body.add(roof)
  const wind = new THREE.Mesh(new THREE.PlaneGeometry(cz * 2, 0.36), glassMat)
  wind.position.set(cx1 + 0.28, yTop - 0.2, 0)
  wind.rotation.y = -Math.PI / 2
  wind.material.side = THREE.DoubleSide
  body.add(wind)
  for (const side of [-1, 1]) {
    const net = new THREE.Mesh(new THREE.PlaneGeometry(cx1 + 0.3 - cx0, yTop - yBase), netMat)
    net.position.set((cx0 + cx1 + 0.3) / 2, (yTop + yBase) / 2, side * cz)
    net.rotation.y = side > 0 ? 0 : Math.PI
    body.add(net)
  }
  // Butaca, piloto, volante y tanque de nafta.
  const seat = new THREE.Mesh(new THREE.BoxGeometry(0.45, 0.7, 0.5), new THREE.MeshStandardMaterial({ color: 0x151515, roughness: 0.9 }))
  seat.position.set(cx0 + 0.25, 0.75, 0.12)
  body.add(seat)
  const torso = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.45, 0.42), suitMat)
  torso.position.set(cx0 + 0.42, 0.72, 0.12)
  body.add(torso)
  const helmet = new THREE.Mesh(new THREE.SphereGeometry(0.16, 14, 12), new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.25, metalness: 0.1 }))
  helmet.position.set(cx0 + 0.42, yTop - 0.3, 0.12)
  body.add(helmet)
  const visor = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.07, 0.24), glassMat)
  visor.position.set(cx0 + 0.56, yTop - 0.29, 0.12)
  body.add(visor)
  const armGeo = new THREE.CylinderGeometry(0.04, 0.04, 0.42, 6)
  for (const side of [-1, 1]) {
    const arm = new THREE.Mesh(armGeo, suitMat)
    arm.rotation.z = -Math.PI / 2 + 0.3
    arm.position.set(cx0 + 0.65, 0.82, 0.12 + side * 0.16)
    body.add(arm)
  }
  const wheel = new THREE.Mesh(new THREE.TorusGeometry(0.15, 0.025, 8, 16), cageMat)
  wheel.rotation.y = Math.PI / 2
  wheel.position.set(cx0 + 0.9, 0.86, 0.12)
  body.add(wheel)
  const tank = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.35, W * 0.5), aluMat)
  tank.position.set(-L * 0.5, 0.42, 0)
  body.add(tank)
  // Paneles laterales con número y equipo.
  for (const side of [-1, 1]) {
    const plate = new THREE.Mesh(new THREE.PlaneGeometry(1.6, 0.3), sideMat)
    plate.position.set(-L * 0.08, 0.42, side * (W * 0.3 + 0.005))
    plate.rotation.y = side > 0 ? 0 : Math.PI
    body.add(plate)
  }
  const rearPlate = new THREE.Mesh(new THREE.PlaneGeometry(0.55, 0.5), decalMat)
  rearPlate.position.set(cx0 - 0.1, yTop - 0.3, cz - 0.1)
  rearPlate.rotation.y = -Math.PI / 2
  body.add(rearPlate)
  const rx = -L * 0.56
  addTube(new THREE.Vector3(rx, 0.28, -W * 0.42), new THREE.Vector3(rx, 0.28, W * 0.42), bumperMat)
  addTube(new THREE.Vector3(rx, 0.62, -W * 0.42), new THREE.Vector3(rx, 0.62, W * 0.42), bumperMat)
  addTube(new THREE.Vector3(rx, 0.28, -W * 0.42), new THREE.Vector3(rx, 0.62, -W * 0.42), bumperMat)
  addTube(new THREE.Vector3(rx, 0.28, W * 0.42), new THREE.Vector3(rx, 0.62, W * 0.42), bumperMat)
  for (const side of [-1, 1]) {
    addTube(new THREE.Vector3(-L * 0.1, 0.4, side * W * 0.5), new THREE.Vector3(L * 0.2, 0.4, side * W * 0.5), trim)
  }
  // Suspensión delantera: brazos en A, amortiguador con resorte y barra de dirección.
  for (const side of [-1, 1]) {
    const hubX = L * 0.36
    const hubZ = side * (W * 0.5 - 0.15)
    for (const y of [0.22, 0.4]) {
      addTube(new THREE.Vector3(hubX + 0.2, y, side * W * 0.28), new THREE.Vector3(hubX, y, hubZ), cageMat)
      addTube(new THREE.Vector3(hubX - 0.2, y, side * W * 0.28), new THREE.Vector3(hubX, y, hubZ), cageMat)
    }
    const shock = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.45, 6), aluMat)
    shock.position.set(hubX + 0.05, 0.5, side * (W * 0.4))
    shock.rotation.x = side * 0.5
    body.add(shock)
    const spring = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 0.28, 8, 1, true), springMat)
    spring.position.copy(shock.position)
    spring.rotation.copy(shock.rotation)
    body.add(spring)
    addTube(new THREE.Vector3(hubX - 0.35, 0.3, 0), new THREE.Vector3(hubX - 0.25, 0.3, hubZ), aluMat)
  }
  // Eje trasero rígido y amortiguadores traseros.
  const axle = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, W * 0.95, 8), cageMat)
  axle.rotation.x = Math.PI / 2
  axle.position.set(-L * 0.4, 0.42, 0)
  body.add(axle)
  const diff = new THREE.Mesh(new THREE.SphereGeometry(0.16, 10, 8), cageMat)
  diff.position.set(-L * 0.4, 0.42, 0)
  body.add(diff)
  for (const side of [-1, 1]) {
    const rs = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.4, 6), aluMat)
    rs.position.set(-L * 0.36, 0.62, side * W * 0.38)
    rs.rotation.z = 0.35
    body.add(rs)
    const rsp = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 0.24, 8, 1, true), springMat)
    rsp.position.copy(rs.position)
    rsp.rotation.copy(rs.rotation)
    body.add(rsp)
  }

  // Sombra de contacto: oscurece el piso justo debajo del auto.
  if (!contactShadowTex) contactShadowTex = makeSoftTexture('rgba(0,0,0,0.55)', 'rgba(0,0,0,0)')
  const contact = new THREE.Mesh(
    new THREE.PlaneGeometry(L * 1.25, W * 1.5),
    new THREE.MeshBasicMaterial({ map: contactShadowTex, transparent: true, depthWrite: false }),
  )
  contact.rotation.x = -Math.PI / 2
  contact.position.y = 0.06
  contact.renderOrder = 1
  group.add(contact)

  const frontWheels: THREE.Object3D[] = []
  const wheels: THREE.Mesh[] = []
  for (const side of [-1, 1]) {
    const pivot = new THREE.Object3D()
    pivot.position.set(L * 0.36, 0.3, side * (W * 0.5))
    const wm = new THREE.Mesh(wheelGeo, rubberMat)
    wm.castShadow = true
    pivot.add(wm)
    const disc = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.2, 0.03, 16), aluMat)
    disc.rotation.x = Math.PI / 2
    wm.add(disc)
    for (let k = 0; k < 5; k++) {
      const sp = new THREE.Mesh(spokeGeo, hubMat)
      sp.rotation.z = (k / 5) * Math.PI * 2
      sp.position.set(Math.sin(sp.rotation.z) * 0.12, Math.cos(sp.rotation.z) * 0.12, 0)
      wm.add(sp)
    }
    group.add(pivot)
    frontWheels.push(pivot)
    wheels.push(wm)

    const rear = new THREE.Mesh(rearWheelGeo, rubberMat)
    rear.castShadow = true
    rear.position.set(-L * 0.4, 0.42, side * (W * 0.52))
    group.add(rear)
    const rim = new THREE.Mesh(rimGeo, hubMat)
    rear.add(rim)
    const nut = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 0.46, 6), cageMat)
    nut.rotation.x = Math.PI / 2
    rear.add(nut)
    for (let k = 0; k < 6; k++) {
      const sp = new THREE.Mesh(spokeGeo, cageMat)
      sp.rotation.z = (k / 6) * Math.PI * 2
      sp.position.set(Math.sin(sp.rotation.z) * 0.16, Math.cos(sp.rotation.z) * 0.16, side * 0.22)
      sp.scale.set(1, 1, 0.3)
      rear.add(sp)
    }
    wheels.push(rear)
  }

  return { group, body, frontWheels, wheels, dust: [], dustAge: [], dustNext: 0, markDist: 0, markIndex: 0 }
}

// ---------------------------------------------------------------------------
// Escena
// ---------------------------------------------------------------------------

export type CameraMode = 'chase' | 'far' | 'hood'

interface PaddockInfo {
  cx: number
  cy: number
  ax: number // dirección "largo" (unitaria)
  ay: number
  halfLen: number
  halfWid: number
}

const MARKS_PER_CAR = 360
const GROUND_SIZE = 1800

export class Scene3D {
  readonly renderer: THREE.WebGLRenderer
  readonly scene = new THREE.Scene()
  readonly camera: THREE.PerspectiveCamera
  private sun!: THREE.DirectionalLight
  private track: Track
  private views = new Map<number, CarView>()
  private dustMat: THREE.SpriteMaterial
  private marks!: THREE.InstancedMesh
  private camPos = new THREE.Vector3()
  private camTarget = new THREE.Vector3()
  private first = true
  private center: THREE.Vector2
  private paddock: PaddockInfo
  private tmpMatrix = new THREE.Matrix4()
  private tmpQuat = new THREE.Quaternion()
  private tmpScale = new THREE.Vector3(1, 1, 1)
  private tmpPos = new THREE.Vector3()
  private composer!: EffectComposer
  private bloom!: UnrealBloomPass
  private smoke: THREE.Sprite[] = []
  private flags: THREE.Mesh[] = []
  private time = 0
  cameraMode: CameraMode = 'chase'

  constructor(canvas: HTMLCanvasElement, track: Track, cars: Car[]) {
    this.track = track
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' })
    this.renderer.shadowMap.enabled = true
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping
    this.renderer.toneMappingExposure = 0.85
    this.renderer.outputColorSpace = THREE.SRGBColorSpace

    this.camera = new THREE.PerspectiveCamera(62, 1, 0.5, 4000)
    this.scene.fog = new THREE.Fog(0xd9dfe3, 350, 2600)

    this.center = new THREE.Vector2((track.bounds.minX + track.bounds.maxX) / 2, (track.bounds.minY + track.bounds.maxY) / 2)
    // Paddock: explanada afuera de la recta principal.
    const s0 = track.points[0]
    const nx = -Math.sin(s0.heading)
    const ny = Math.cos(s0.heading)
    const outward = (s0.x - this.center.x) * nx + (s0.y - this.center.y) * ny > 0 ? 1 : -1
    const off = track.width / 2 + 75
    this.paddock = {
      cx: s0.x + Math.cos(s0.heading) * 60 + nx * off * outward,
      cy: s0.y + Math.sin(s0.heading) * 60 + ny * off * outward,
      ax: Math.cos(s0.heading),
      ay: Math.sin(s0.heading),
      halfLen: 150,
      halfWid: 45,
    }

    this.dustMat = new THREE.SpriteMaterial({
      map: makeSoftTexture('rgba(232,214,186,0.85)', 'rgba(220,200,170,0)'),
      transparent: true,
      depthWrite: false,
      opacity: 0.8,
    })

    this.buildSky()
    this.buildEnvironmentMap()
    this.buildLights()
    this.buildGround()
    this.buildTrack()
    this.buildSurroundings()
    this.buildMarks(cars.length)
    this.buildPostProcessing()
    for (const c of cars) {
      const v = buildCar(c)
      this.scene.add(v.group)
      this.views.set(c.id, v)
      if (c.model) this.attachModel(c, v)
    }
  }

  /** Reemplaza el auto procedural por el modelo generado a partir de fotos, cuando termina de cargar. */
  private attachModel(car: Car, view: CarView) {
    const cfg = car.model!
    loadCarModel(cfg)
      .then((model) => {
        if (car.modelHue) applyHueShift(model, cfg.key, car.modelHue)
        // Ocultar carrocería y ruedas procedurales; conservar sombra de contacto y polvo.
        view.body.visible = false
        for (const fw of view.frontWheels) fw.visible = false
        for (const w of view.wheels) w.visible = false
        view.group.add(model)
      })
      .catch((err: unknown) => {
        console.warn('No se pudo cargar el modelo del auto', cfg.url, err)
      })
  }

  /** Bloom suave, viñeta con leve calidez y antialiasing SMAA. */
  private buildPostProcessing() {
    this.composer = new EffectComposer(this.renderer)
    this.composer.addPass(new RenderPass(this.scene, this.camera))
    this.bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.22, 0.6, 0.85)
    this.composer.addPass(this.bloom)
    const grade = new ShaderPass({
      uniforms: { tDiffuse: { value: null }, strength: { value: 0.55 } },
      vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
      fragmentShader: `uniform sampler2D tDiffuse; uniform float strength; varying vec2 vUv;
        void main(){
          vec4 c = texture2D(tDiffuse, vUv);
          // Viñeta.
          vec2 d = vUv - 0.5; float v = 1.0 - smoothstep(0.35, 0.95, length(d) * 1.35) * strength;
          // Un poco más de saturación y calidez de tarde.
          float l = dot(c.rgb, vec3(0.299, 0.587, 0.114));
          vec3 sat = mix(vec3(l), c.rgb, 1.12);
          sat *= vec3(1.03, 1.0, 0.96);
          gl_FragColor = vec4(sat * v, c.a);
        }`,
    })
    this.composer.addPass(grade)
    this.composer.addPass(new OutputPass())
    this.composer.addPass(new SMAAPass())
  }

  private buildSky() {
    const geo = new THREE.SphereGeometry(3000, 24, 12)
    const mat = new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
      uniforms: {
        top: { value: new THREE.Color(0x4f8fd0) },
        mid: { value: new THREE.Color(0x9cc0e2) },
        horizon: { value: new THREE.Color(0xe4e6e2) },
      },
      vertexShader: `varying vec3 vPos; void main(){ vPos = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
      fragmentShader: `uniform vec3 top; uniform vec3 mid; uniform vec3 horizon; varying vec3 vPos;
        void main(){ float h = normalize(vPos).y; vec3 c = mix(horizon, mid, smoothstep(-0.02, 0.18, h)); c = mix(c, top, smoothstep(0.18, 0.7, h)); gl_FragColor = vec4(c, 1.0); }`,
    })
    this.scene.add(new THREE.Mesh(geo, mat))

    // Nubes altas: sprites suaves lejos, sin niebla.
    const cloudTex = makeCloudTexture()
    const rnd = makeRng(77)
    for (let k = 0; k < 16; k++) {
      const m = new THREE.SpriteMaterial({ map: cloudTex, transparent: true, depthWrite: false, opacity: 0.75, fog: false })
      const s = new THREE.Sprite(m)
      const ang = rnd() * Math.PI * 2
      const r = 900 + rnd() * 900
      s.position.set(this.center.x + Math.cos(ang) * r, 260 + rnd() * 160, this.center.y + Math.sin(ang) * r)
      const w = 500 + rnd() * 500
      s.scale.set(w, w * 0.45, 1)
      this.scene.add(s)
    }
  }

  /** Reflejos: el propio cielo y el suelo como mapa de entorno para pintura y metal. */
  private buildEnvironmentMap() {
    const envScene = new THREE.Scene()
    const sky = this.scene.children.find((o) => o instanceof THREE.Mesh && (o.material as THREE.Material).type === 'ShaderMaterial') as THREE.Mesh | undefined
    if (sky) envScene.add(sky.clone())
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(6000, 6000), new THREE.MeshBasicMaterial({ color: 0x8a6b48 }))
    ground.rotation.x = -Math.PI / 2
    ground.position.y = -2
    envScene.add(ground)
    const pmrem = new THREE.PMREMGenerator(this.renderer)
    this.scene.environment = pmrem.fromScene(envScene, 0.02, 0.5, 5000).texture
    this.scene.environmentIntensity = 0.35
    pmrem.dispose()
  }

  private buildLights() {
    const hemi = new THREE.HemisphereLight(0xcfe0f5, 0x6a4f36, 0.4)
    this.scene.add(hemi)
    this.sun = new THREE.DirectionalLight(0xffe9c8, 1.9)
    this.sun.castShadow = true
    this.sun.shadow.mapSize.set(4096, 4096)
    const s = 60
    this.sun.shadow.camera.left = -s
    this.sun.shadow.camera.right = s
    this.sun.shadow.camera.top = s
    this.sun.shadow.camera.bottom = -s
    this.sun.shadow.camera.near = 20
    this.sun.shadow.camera.far = 320
    this.sun.shadow.bias = -0.0004
    this.sun.shadow.radius = 3
    this.sun.shadow.blurSamples = 8
    this.scene.add(this.sun)
    this.scene.add(this.sun.target)
    const flareTex = makeSoftTexture('rgba(255,244,214,1)', 'rgba(255,230,180,0)')
    const ringTex = makeSoftTexture('rgba(255,200,150,0.35)', 'rgba(255,200,150,0)')
    const flare = new Lensflare()
    flare.addElement(new LensflareElement(flareTex, 420, 0, new THREE.Color(0xfff2d8)))
    flare.addElement(new LensflareElement(ringTex, 90, 0.35))
    flare.addElement(new LensflareElement(ringTex, 140, 0.6))
    flare.addElement(new LensflareElement(ringTex, 60, 0.9))
    this.sun.add(flare)
  }

  private buildGround() {
    const tex = makeGroundTexture(this.track, 2048, this.center, GROUND_SIZE, this.paddock)
    const bump = makeLooseDirtTexture()
    bump.repeat.set(GROUND_SIZE / 6, GROUND_SIZE / 6)
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(GROUND_SIZE, GROUND_SIZE), new THREE.MeshStandardMaterial({ map: tex, roughness: 1, bumpMap: bump, bumpScale: 0.35 }))
    ground.rotation.x = -Math.PI / 2
    ground.position.set(this.center.x, 0, this.center.y)
    ground.receiveShadow = true
    this.scene.add(ground)
    // Más allá: llanura uniforme hasta la niebla.
    const far = new THREE.Mesh(new THREE.PlaneGeometry(8000, 8000), new THREE.MeshStandardMaterial({ color: 0x7a5e42, roughness: 1 }))
    far.rotation.x = -Math.PI / 2
    far.position.set(this.center.x, -0.05, this.center.y)
    this.scene.add(far)
  }

  /** Cinta a lo largo de la pista con perfil transversal arbitrario (offsets, alturas). */
  private ribbon(profile: { off: number; y: number }[], mat: THREE.Material, vRepeat: number): THREE.Mesh {
    const t = this.track
    const n = t.points.length
    const cols = profile.length
    const pos = new Float32Array((n + 1) * cols * 3)
    const uv = new Float32Array((n + 1) * cols * 2)
    const idx: number[] = []
    for (let i = 0; i <= n; i++) {
      const p = t.pointAt(i)
      const nx = -Math.sin(p.heading)
      const ny = Math.cos(p.heading)
      for (let c = 0; c < cols; c++) {
        const o = (i * cols + c) * 3
        pos[o] = p.x + nx * profile[c].off
        pos[o + 1] = profile[c].y
        pos[o + 2] = p.y + ny * profile[c].off
        uv[(i * cols + c) * 2] = c / (cols - 1)
        uv[(i * cols + c) * 2 + 1] = (i / n) * vRepeat
      }
      if (i < n) {
        for (let c = 0; c < cols - 1; c++) {
          const a = i * cols + c
          const b = a + cols
          idx.push(a, a + 1, b, a + 1, b + 1, b)
        }
      }
    }
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3))
    g.setAttribute('uv', new THREE.BufferAttribute(uv, 2))
    g.setIndex(idx)
    g.computeVertexNormals()
    const m = new THREE.Mesh(g, mat)
    m.receiveShadow = true
    return m
  }

  private buildTrack() {
    const t = this.track
    const half = t.width / 2
    const trackTex = makeTrackTexture()
    trackTex.repeat.set(1, 1)
    this.scene.add(
      this.ribbon(
        [{ off: -half, y: 0.04 }, { off: half, y: 0.04 }],
        new THREE.MeshStandardMaterial({ map: trackTex, roughness: 0.95, bumpMap: trackTex, bumpScale: 0.12 }),
        34,
      ),
    )

    // Bermas: lomo de tierra suelta a cada lado, más alto en el exterior de las curvas.
    const loose = makeLooseDirtTexture()
    loose.repeat.set(1, 1)
    const looseMat = new THREE.MeshStandardMaterial({ map: loose, roughness: 1, side: THREE.DoubleSide, bumpMap: loose, bumpScale: 0.3 })
    for (const side of [-1, 1]) {
      this.scene.add(
        this.ribbon(
          [
            { off: side * (half - 0.2), y: 0.03 },
            { off: side * (half + 1.6), y: 0.42 },
            { off: side * (half + 3.2), y: 0.28 },
            { off: side * (half + 6), y: 0.0 },
          ],
          looseMat,
          220,
        ),
      )
    }

    // Línea de largada pintada y arco de largada.
    const s0 = t.points[0]
    const line = new THREE.Mesh(new THREE.PlaneGeometry(1.0, t.width), new THREE.MeshStandardMaterial({ color: 0xf4f4f4 }))
    line.rotation.x = -Math.PI / 2
    line.rotation.z = -s0.heading
    line.position.set(s0.x, 0.06, s0.y)
    this.scene.add(line)
    const nx = -Math.sin(s0.heading)
    const ny = Math.cos(s0.heading)
    const postGeo = new THREE.CylinderGeometry(0.12, 0.12, 6, 8)
    const postMat = new THREE.MeshStandardMaterial({ color: 0xdddddd, metalness: 0.4 })
    for (const side of [-1, 1]) {
      const post = new THREE.Mesh(postGeo, postMat)
      post.position.set(s0.x + nx * side * (half + 2), 3, s0.y + ny * side * (half + 2))
      post.castShadow = true
      this.scene.add(post)
    }
    const beam = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.8, t.width + 4), new THREE.MeshStandardMaterial({ color: 0xffffff }))
    beam.position.set(s0.x, 5.8, s0.y)
    beam.rotation.y = -s0.heading
    beam.castShadow = true
    this.scene.add(beam)

    // Cubiertas de protección en el exterior de las curvas cerradas.
    const tireGeo = new THREE.TorusGeometry(0.42, 0.18, 8, 14)
    tireGeo.rotateX(Math.PI / 2)
    const tirePositions: THREE.Matrix4[] = []
    const n = t.points.length
    for (let i = 0; i < n; i += 3) {
      const p = t.points[i]
      if (Math.abs(p.curvature) > 0.02) {
        const side = Math.sign(p.curvature)
        const pnx = -Math.sin(p.heading)
        const pny = Math.cos(p.heading)
        const off = half + 8
        for (let stack = 0; stack < 2; stack++) {
          const m = new THREE.Matrix4()
          m.setPosition(p.x - pnx * off * side, 0.18 + stack * 0.36, p.y - pny * off * side)
          tirePositions.push(m)
        }
      }
    }
    if (tirePositions.length) {
      const tires = new THREE.InstancedMesh(tireGeo, rubberMat, tirePositions.length)
      tirePositions.forEach((m, i) => tires.setMatrixAt(i, m))
      tires.castShadow = true
      this.scene.add(tires)
    }
  }

  private buildSurroundings() {
    const t = this.track
    const half = t.width / 2
    const n = t.points.length
    const rnd = makeRng(2024)
    const cxm = this.center.x
    const cym = this.center.y
    const outwardAt = (p: { x: number; y: number; heading: number }) => {
      const nx = -Math.sin(p.heading)
      const ny = Math.cos(p.heading)
      return (p.x - cxm) * nx + (p.y - cym) * ny > 0 ? 1 : -1
    }

    // --- Terraplén perimetral donde se instala el público ---
    const embankMat = new THREE.MeshStandardMaterial({ map: makeLooseDirtTexture(), roughness: 1, side: THREE.DoubleSide })
    ;(embankMat.map as THREE.Texture).repeat.set(2, 1)
    const embankProfile = (side: number) => [
      { off: side * (half + 10), y: 0 },
      { off: side * (half + 14), y: 1.3 },
      { off: side * (half + 30), y: 1.3 },
      { off: side * (half + 35), y: 0 },
    ]
    // El terraplén va por el lado exterior; se construye por tramos del mismo lado.
    for (const side of [-1, 1]) {
      const mesh = this.ribbon(embankProfile(side), embankMat, 300)
      // Ocultar los tramos donde ese lado es el interior: se colapsa la altura.
      const pos = mesh.geometry.getAttribute('position') as THREE.BufferAttribute
      for (let i = 0; i <= n; i++) {
        const p = t.pointAt(i)
        if (outwardAt(p) !== side) {
          for (let c = 0; c < 4; c++) pos.setY(i * 4 + c, -0.5)
        }
      }
      pos.needsUpdate = true
      mesh.geometry.computeVertexNormals()
      this.scene.add(mesh)
    }
    const EMB_Y = 1.3

    // --- Autos del público alrededor de toda la pista, sobre el terraplén ---
    const bodyGeo = new THREE.BoxGeometry(4.3, 1.3, 1.85)
    const cabinGeo = new THREE.BoxGeometry(2.1, 0.75, 1.65)
    const palette = [0xf2f2f2, 0xd0d0d0, 0x9a9a9a, 0x2b2b2b, 0x8c1d1d, 0x1c3f94, 0x5a5a5a, 0xe6e6e6, 0x274e13, 0xb8b8b8, 0xffffff]
    const spectators: { x: number; y: number; rot: number; color: number; y0?: number }[] = []
    const pickups: { x: number; y: number; rot: number; color: number; y0: number }[] = []
    const trucksRing: { x: number; y: number; rot: number; y0: number }[] = []
    const people: { x: number; y: number; y0: number; color: number; rot: number }[] = []
    const grills: { x: number; y: number; y0: number }[] = []
    const flags: { x: number; y: number; y0: number; color: number }[] = []
    const ringSpot = (i: number, extra: number) => {
      const p = t.points[i]
      const nx = -Math.sin(p.heading)
      const ny = Math.cos(p.heading)
      const outward = outwardAt(p)
      const off = half + 19 + extra
      return { x: p.x + nx * off * outward, y: p.y + ny * off * outward, heading: p.heading, outward, nx, ny }
    }
    for (let i = 0; i < n; i += 6) {
      if (rnd() < 0.1) continue
      const spot = ringSpot(i, rnd() * 6)
      const r = rnd()
      const rot = -spot.heading + Math.PI / 2 + (rnd() - 0.5) * 0.35
      if (r < 0.55) spectators.push({ x: spot.x, y: spot.y, rot, color: palette[Math.floor(rnd() * palette.length)], y0: EMB_Y })
      else if (r < 0.88) pickups.push({ x: spot.x, y: spot.y, rot, color: palette[Math.floor(rnd() * palette.length)], y0: EMB_Y })
      else trucksRing.push({ x: spot.x, y: spot.y, rot, y0: EMB_Y })
      // Gente alrededor del vehículo, mirando a la pista.
      const group = 1 + Math.floor(rnd() * 4)
      for (let g = 0; g < group; g++) {
        const along = (rnd() - 0.5) * 5
        const toward = 3 + rnd() * 2
        people.push({
          x: spot.x + Math.cos(spot.heading) * along - spot.nx * toward * spot.outward,
          y: spot.y + Math.sin(spot.heading) * along - spot.ny * toward * spot.outward,
          y0: EMB_Y,
          color: [0xffffff, 0x1f2a44, 0x8c1d1d, 0x2a7f3a, 0xf2c94c, 0x222222, 0x5b8fd6][Math.floor(rnd() * 7)],
          rot: -spot.heading + (spot.outward > 0 ? Math.PI / 2 : -Math.PI / 2),
        })
      }
      if (rnd() < 0.35) {
        grills.push({ x: spot.x + Math.cos(spot.heading) * 3.5, y: spot.y + Math.sin(spot.heading) * 3.5, y0: EMB_Y })
      }
      if (rnd() < 0.12) flags.push({ x: spot.x + spot.nx * 4 * spot.outward, y: spot.y + spot.ny * 4 * spot.outward, y0: EMB_Y, color: [0x74acdf, 0xffffff, 0xd42020, 0xf2c94c][Math.floor(rnd() * 4)] })
    }
    // Paddock: autos, camionetas y trailers en filas.
    const pd = this.paddock
    for (let r = -3; r <= 3; r++) {
      for (let c = -12; c <= 12; c++) {
        if (rnd() < 0.3) continue
        const along = c * 11 + (rnd() - 0.5) * 3
        const across = r * 12 + (rnd() - 0.5) * 3
        spectators.push({
          x: pd.cx + pd.ax * along - pd.ay * across,
          y: pd.cy + pd.ay * along + pd.ax * across,
          rot: -Math.atan2(pd.ay, pd.ax) + (rnd() < 0.5 ? 0 : Math.PI / 2) + (rnd() - 0.5) * 0.3,
          color: palette[Math.floor(rnd() * palette.length)],
        })
      }
    }
    const bodies = new THREE.InstancedMesh(bodyGeo, new THREE.MeshStandardMaterial({ roughness: 0.35, metalness: 0.4 }), spectators.length)
    const cabins = new THREE.InstancedMesh(cabinGeo, new THREE.MeshStandardMaterial({ color: 0x2a3340, roughness: 0.2, metalness: 0.5 }), spectators.length)
    const wheelSetGeo = new THREE.CylinderGeometry(0.34, 0.34, 0.25, 10)
    wheelSetGeo.rotateX(Math.PI / 2)
    const allVehicleWheels: THREE.Matrix4[] = []
    const addWheels = (x: number, y: number, y0: number, rot: number, wb: number, tw: number) => {
      const fx = Math.cos(-rot)
      const fz = Math.sin(-rot)
      for (const a of [-1, 1]) {
        for (const b of [-1, 1]) {
          allVehicleWheels.push(
            new THREE.Matrix4().compose(
              new THREE.Vector3(x + fx * a * wb - fz * b * tw, y0 + 0.34, y + fz * a * wb + fx * b * tw),
              new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), rot),
              new THREE.Vector3(1, 1, 1),
            ),
          )
        }
      }
    }
    spectators.forEach((s, i) => {
      const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), s.rot)
      const y0 = s.y0 ?? 0
      bodies.setMatrixAt(i, new THREE.Matrix4().compose(new THREE.Vector3(s.x, y0 + 0.75, s.y), q, new THREE.Vector3(1, 1, 1)))
      cabins.setMatrixAt(i, new THREE.Matrix4().compose(new THREE.Vector3(s.x, y0 + 1.75, s.y), q, new THREE.Vector3(1, 1, 1)))
      bodies.setColorAt(i, new THREE.Color(s.color))
      addWheels(s.x, s.y, y0, s.rot, 1.4, 0.85)
    })
    bodies.castShadow = true
    cabins.castShadow = true
    this.scene.add(bodies, cabins)

    // Camionetas: cabina adelante y caja abierta atrás.
    const puBodyGeo = new THREE.BoxGeometry(5.2, 1.0, 1.95)
    const puCabGeo = new THREE.BoxGeometry(2.0, 1.1, 1.85)
    const puBedGeo = new THREE.BoxGeometry(2.4, 0.5, 1.85)
    const puBodies = new THREE.InstancedMesh(puBodyGeo, new THREE.MeshStandardMaterial({ roughness: 0.35, metalness: 0.4 }), pickups.length)
    const puCabs = new THREE.InstancedMesh(puCabGeo, new THREE.MeshStandardMaterial({ color: 0x2a3340, roughness: 0.2, metalness: 0.5 }), pickups.length)
    const puBeds = new THREE.InstancedMesh(puBedGeo, new THREE.MeshStandardMaterial({ color: 0x333333, roughness: 0.8 }), pickups.length)
    pickups.forEach((s, i) => {
      const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), s.rot)
      const fx = Math.cos(-s.rot)
      const fz = Math.sin(-s.rot)
      puBodies.setMatrixAt(i, new THREE.Matrix4().compose(new THREE.Vector3(s.x, s.y0 + 0.9, s.y), q, new THREE.Vector3(1, 1, 1)))
      puCabs.setMatrixAt(i, new THREE.Matrix4().compose(new THREE.Vector3(s.x + fx * 0.6, s.y0 + 1.95, s.y + fz * 0.6), q, new THREE.Vector3(1, 1, 1)))
      puBeds.setMatrixAt(i, new THREE.Matrix4().compose(new THREE.Vector3(s.x - fx * 1.4, s.y0 + 1.65, s.y - fz * 1.4), q, new THREE.Vector3(1, 1, 1)))
      puBodies.setColorAt(i, new THREE.Color(s.color))
      addWheels(s.x, s.y, s.y0, s.rot, 1.6, 0.9)
    })
    puBodies.castShadow = true
    puCabs.castShadow = true
    this.scene.add(puBodies, puCabs, puBeds)

    // Camiones en el terraplén (la gente mira desde arriba de la caja).
    const trBodyGeo = new THREE.BoxGeometry(8, 2.6, 2.5)
    const trCabGeo = new THREE.BoxGeometry(2.2, 2.4, 2.4)
    const trBodies = new THREE.InstancedMesh(trBodyGeo, new THREE.MeshStandardMaterial({ color: 0xe8e2d2, roughness: 0.5 }), trucksRing.length)
    const trCabs = new THREE.InstancedMesh(trCabGeo, new THREE.MeshStandardMaterial({ roughness: 0.4, metalness: 0.3 }), trucksRing.length)
    trucksRing.forEach((s, i) => {
      const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), s.rot)
      const fx = Math.cos(-s.rot)
      const fz = Math.sin(-s.rot)
      trBodies.setMatrixAt(i, new THREE.Matrix4().compose(new THREE.Vector3(s.x - fx * 1.2, s.y0 + 2.1, s.y - fz * 1.2), q, new THREE.Vector3(1, 1, 1)))
      trCabs.setMatrixAt(i, new THREE.Matrix4().compose(new THREE.Vector3(s.x + fx * 4.0, s.y0 + 1.9, s.y + fz * 4.0), q, new THREE.Vector3(1, 1, 1)))
      trCabs.setColorAt(i, new THREE.Color([0xd42020, 0x1c3f94, 0xffffff, 0x2a7f3a][i % 4]))
      addWheels(s.x, s.y, s.y0, s.rot, 2.6, 1.1)
      // Gente arriba del camión.
      for (let g = 0; g < 3; g++) {
        people.push({ x: s.x - fx * 1.2 + (rnd() - 0.5) * 5, y: s.y - fz * 1.2 + (rnd() - 0.5) * 1.5, y0: s.y0 + 3.4, color: [0xffffff, 0x1f2a44, 0x8c1d1d, 0xf2c94c][g % 4], rot: s.rot })
      }
    })
    trBodies.castShadow = true
    this.scene.add(trBodies, trCabs)
    const vWheels = new THREE.InstancedMesh(wheelSetGeo, rubberMat, allVehicleWheels.length)
    allVehicleWheels.forEach((m, i) => vWheels.setMatrixAt(i, m))
    this.scene.add(vWheels)

    // Público: cuerpo + cabeza, colores de ropa variados.
    const personBody = new THREE.CapsuleGeometry(0.2, 0.9, 3, 6)
    const personHead = new THREE.SphereGeometry(0.13, 8, 6)
    const bodiesP = new THREE.InstancedMesh(personBody, new THREE.MeshStandardMaterial({ roughness: 0.9 }), people.length)
    const headsP = new THREE.InstancedMesh(personHead, new THREE.MeshStandardMaterial({ color: 0xc8956c, roughness: 0.8 }), people.length)
    people.forEach((pp, i) => {
      const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), pp.rot)
      const h = 0.9 + rnd() * 0.25
      bodiesP.setMatrixAt(i, new THREE.Matrix4().compose(new THREE.Vector3(pp.x, pp.y0 + 0.65 * h, pp.y), q, new THREE.Vector3(1, h, 1)))
      headsP.setMatrixAt(i, new THREE.Matrix4().compose(new THREE.Vector3(pp.x, pp.y0 + 1.42 * h, pp.y), q, new THREE.Vector3(1, 1, 1)))
      bodiesP.setColorAt(i, new THREE.Color(pp.color))
    })
    bodiesP.castShadow = true
    this.scene.add(bodiesP, headsP)

    // Parrillas para el asado, con humo.
    const grillGeo = new THREE.BoxGeometry(0.9, 0.12, 0.5)
    const grillMesh = new THREE.InstancedMesh(grillGeo, cageMat, grills.length)
    const grillLegs = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.02, 0.02, 0.8, 4), cageMat, grills.length * 4)
    grills.forEach((g, i) => {
      grillMesh.setMatrixAt(i, new THREE.Matrix4().setPosition(g.x, g.y0 + 0.8, g.y))
      ;[
        [-0.4, -0.2],
        [0.4, -0.2],
        [-0.4, 0.2],
        [0.4, 0.2],
      ].forEach(([dx, dz], c) => grillLegs.setMatrixAt(i * 4 + c, new THREE.Matrix4().setPosition(g.x + dx, g.y0 + 0.4, g.y + dz)))
    })
    this.scene.add(grillMesh, grillLegs)
    const smokeTex = makeSoftTexture('rgba(210,210,215,0.6)', 'rgba(200,200,205,0)')
    for (const g of grills) {
      for (let k = 0; k < 5; k++) {
        const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: smokeTex, transparent: true, depthWrite: false, opacity: 0.4 }))
        sp.position.set(g.x, g.y0 + 1, g.y)
        sp.userData.base = new THREE.Vector3(g.x, g.y0 + 1, g.y)
        sp.userData.phase = k / 5 + rnd() * 0.1
        sp.userData.drift = (rnd() - 0.5) * 0.6
        this.scene.add(sp)
        this.smoke.push(sp)
      }
    }

    // Banderas.
    const poleGeo = new THREE.CylinderGeometry(0.03, 0.03, 4, 5)
    const flagGeo = new THREE.PlaneGeometry(1.4, 0.9, 6, 1)
    flags.forEach((f) => {
      const pole = new THREE.Mesh(poleGeo, hubMat)
      pole.position.set(f.x, f.y0 + 2, f.y)
      this.scene.add(pole)
      const flag = new THREE.Mesh(flagGeo, new THREE.MeshStandardMaterial({ color: f.color, side: THREE.DoubleSide, roughness: 0.9 }))
      flag.position.set(f.x + 0.7, f.y0 + 3.5, f.y)
      flag.userData.phase = rnd() * 6
      this.scene.add(flag)
      this.flags.push(flag)
    })

    // Gazebos de colores en el paddock y trailers grandes.
    const roofGeo = new THREE.ConeGeometry(2.6, 1.1, 4)
    const gazeboColors = [0x1f5fd6, 0xffffff, 0xd42020, 0x1f5fd6, 0x2a7f3a, 0xffffff]
    const gazebos: THREE.Matrix4[] = []
    const gazeboCol: number[] = []
    for (let k = 0; k < 40; k++) {
      const along = (rnd() - 0.5) * pd.halfLen * 1.8
      const across = (rnd() - 0.5) * pd.halfWid * 1.6
      gazebos.push(
        new THREE.Matrix4().compose(
          new THREE.Vector3(pd.cx + pd.ax * along - pd.ay * across, 2.9, pd.cy + pd.ay * along + pd.ax * across),
          new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 4),
          new THREE.Vector3(1, 1, 1),
        ),
      )
      gazeboCol.push(gazeboColors[Math.floor(rnd() * gazeboColors.length)])
    }
    const gz = new THREE.InstancedMesh(roofGeo, new THREE.MeshStandardMaterial({ roughness: 0.7 }), gazebos.length)
    gazebos.forEach((m, i) => {
      gz.setMatrixAt(i, m)
      gz.setColorAt(i, new THREE.Color(gazeboCol[i]))
    })
    gz.castShadow = true
    this.scene.add(gz)
    const legGeo = new THREE.CylinderGeometry(0.04, 0.04, 2.4, 5)
    const legs = new THREE.InstancedMesh(legGeo, cageMat, gazebos.length * 4)
    gazebos.forEach((m, i) => {
      const p = new THREE.Vector3().setFromMatrixPosition(m)
      const corners = [
        [-1.8, -1.8],
        [1.8, -1.8],
        [-1.8, 1.8],
        [1.8, 1.8],
      ]
      corners.forEach(([dx, dz], c) => legs.setMatrixAt(i * 4 + c, new THREE.Matrix4().setPosition(p.x + dx, 1.2, p.z + dz)))
    })
    this.scene.add(legs)
    const truckGeo = new THREE.BoxGeometry(9, 3.2, 2.5)
    const trucks = new THREE.InstancedMesh(truckGeo, new THREE.MeshStandardMaterial({ color: 0xf0f0f0, roughness: 0.4 }), 10)
    for (let k = 0; k < 10; k++) {
      const along = -pd.halfLen + 20 + k * 30
      const across = pd.halfWid - 6
      trucks.setMatrixAt(
        k,
        new THREE.Matrix4().compose(
          new THREE.Vector3(pd.cx + pd.ax * along - pd.ay * across, 1.6, pd.cy + pd.ay * along + pd.ax * across),
          new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), -Math.atan2(pd.ay, pd.ax)),
          new THREE.Vector3(1, 1, 1),
        ),
      )
    }
    trucks.castShadow = true
    this.scene.add(trucks)

    // Torre de control chica junto a la largada.
    const s0 = t.points[0]
    const outward0 = outwardAt(s0)
    const tnx = -Math.sin(s0.heading)
    const tny = Math.cos(s0.heading)
    const tower = new THREE.Group()
    const towerBody = new THREE.Mesh(new THREE.BoxGeometry(3.2, 2.4, 2.6), new THREE.MeshStandardMaterial({ color: 0xf0ede4 }))
    towerBody.position.y = 4.4
    towerBody.castShadow = true
    tower.add(towerBody)
    const towerWin = new THREE.Mesh(new THREE.BoxGeometry(3.25, 1.0, 2.65), glassMat)
    towerWin.position.y = 4.7
    tower.add(towerWin)
    for (const [dx, dz] of [
      [-1.6, -1.2],
      [1.6, -1.2],
      [-1.6, 1.2],
      [1.6, 1.2],
    ]) {
      const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.08, 3.2, 6), cageMat)
      leg.position.set(dx * 0.8, 1.6, dz * 0.9)
      tower.add(leg)
    }
    tower.position.set(s0.x - Math.cos(s0.heading) * 8 + tnx * (half + 12) * outward0, 0, s0.y - Math.sin(s0.heading) * 8 + tny * (half + 12) * outward0)
    tower.rotation.y = -s0.heading
    this.scene.add(tower)

    // --- Monte: arbustos bajos por todos lados, salvo pista y paddock ---
    const bushGeo = new THREE.IcosahedronGeometry(1, 1)
    const bushMat = new THREE.MeshStandardMaterial({ color: 0x5e7a3a, roughness: 1, flatShading: true })
    const bushes: THREE.Matrix4[] = []
    const inPaddock = (x: number, y: number) => {
      const dx = x - pd.cx
      const dy = y - pd.cy
      const a = dx * pd.ax + dy * pd.ay
      const b = -dx * pd.ay + dy * pd.ax
      return Math.abs(a) < pd.halfLen + 12 && Math.abs(b) < pd.halfWid + 12
    }
    const nearTrack = (x: number, y: number, m: number) => {
      const p = t.points[t.nearestIndex(x, y)]
      return Math.hypot(p.x - x, p.y - y) < half + m
    }
    for (let k = 0; k < 2600; k++) {
      const x = cxm + (rnd() - 0.5) * GROUND_SIZE * 0.9
      const y = cym + (rnd() - 0.5) * GROUND_SIZE * 0.9
      if (nearTrack(x, y, 30) || inPaddock(x, y)) continue
      const s = 0.8 + rnd() * 1.6
      bushes.push(new THREE.Matrix4().compose(new THREE.Vector3(x, s * 0.45, y), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), rnd() * 6), new THREE.Vector3(s, s * 0.6, s)))
    }
    const bushMesh = new THREE.InstancedMesh(bushGeo, bushMat, bushes.length)
    bushes.forEach((m, i) => {
      bushMesh.setMatrixAt(i, m)
      bushMesh.setColorAt(i, new THREE.Color().setHSL(0.22 + rnd() * 0.06, 0.35 + rnd() * 0.2, 0.28 + rnd() * 0.12))
    })
    this.scene.add(bushMesh)

    // Árboles: pocos, algunos cerca del paddock y una hilera lejana.
    const trunkGeo = new THREE.CylinderGeometry(0.22, 0.32, 5, 6)
    const crownGeo = new THREE.IcosahedronGeometry(3, 1)
    const trunks: THREE.Matrix4[] = []
    const crowns: THREE.Matrix4[] = []
    const addTree = (x: number, y: number, sc: number) => {
      trunks.push(new THREE.Matrix4().compose(new THREE.Vector3(x, 2.5 * sc, y), new THREE.Quaternion(), new THREE.Vector3(sc, sc, sc)))
      crowns.push(new THREE.Matrix4().compose(new THREE.Vector3(x, 6.5 * sc, y), new THREE.Quaternion(), new THREE.Vector3(sc, sc * 0.85, sc)))
    }
    for (let k = 0; k < 18; k++) {
      const x = cxm + (rnd() - 0.5) * 900
      const y = cym + (rnd() - 0.5) * 700
      if (nearTrack(x, y, 45) || inPaddock(x, y)) continue
      addTree(x, y, 0.8 + rnd() * 0.8)
    }
    for (let k = 0; k < 90; k++) addTree(cxm - 800 + k * 18 + (rnd() - 0.5) * 6, cym - 700 + (rnd() - 0.5) * 20, 1 + rnd() * 0.5)

    // Río Atuel: corre de norte a sur pegado al oeste del circuito, con un
    // cordón de árboles y juncos en las dos orillas.
    const riverX = t.bounds.minX - 45
    const water = new THREE.Mesh(
      new THREE.PlaneGeometry(38, 2400, 1, 40),
      new THREE.MeshStandardMaterial({ color: 0x4d6b78, roughness: 0.15, metalness: 0.5 }),
    )
    water.rotation.x = -Math.PI / 2
    water.position.set(riverX, 0.02, cym)
    // Meandros suaves.
    const wp = water.geometry.getAttribute('position') as THREE.BufferAttribute
    for (let i = 0; i < wp.count; i++) wp.setX(i, wp.getX(i) + Math.sin(wp.getY(i) / 180) * 25)
    wp.needsUpdate = true
    this.scene.add(water)
    const reedGeo = new THREE.ConeGeometry(0.5, 2.2, 5)
    const reeds = new THREE.InstancedMesh(reedGeo, new THREE.MeshStandardMaterial({ color: 0x6f7f3b, roughness: 1 }), 500)
    for (let k = 0; k < 500; k++) {
      const yy = cym + (rnd() - 0.5) * 2200
      const side = rnd() < 0.5 ? -1 : 1
      reeds.setMatrixAt(k, new THREE.Matrix4().setPosition(riverX + Math.sin(yy / 180) * 25 + side * (20 + rnd() * 6), 1, yy))
    }
    this.scene.add(reeds)
    for (let k = 0; k < 160; k++) {
      const yy = cym + (rnd() - 0.5) * 2200
      const side = rnd() < 0.5 ? -1 : 1
      addTree(riverX + Math.sin(yy / 180) * 25 + side * (28 + rnd() * 25), yy, 0.9 + rnd() * 0.8)
    }

    const trunkMesh = new THREE.InstancedMesh(trunkGeo, new THREE.MeshStandardMaterial({ color: 0x5a4632 }), trunks.length)
    const crownMesh = new THREE.InstancedMesh(crownGeo, new THREE.MeshStandardMaterial({ color: 0x4a6e30, roughness: 0.9, flatShading: true }), crowns.length)
    trunks.forEach((m, i) => trunkMesh.setMatrixAt(i, m))
    crowns.forEach((m, i) => crownMesh.setMatrixAt(i, m))
    crownMesh.castShadow = true
    this.scene.add(trunkMesh, crownMesh)

    // Cerro Nevado: un solo cerro bajo y lejano, con nieve en la cumbre.
    const hillMat = new THREE.MeshStandardMaterial({ color: 0x8a94a4, flatShading: true, roughness: 1 })
    const snowMat = new THREE.MeshStandardMaterial({ color: 0xf6f8fa, flatShading: true, roughness: 1 })
    const cerroDist = 2300
    const cerroAng = Math.PI
    const cerroX = cxm + Math.cos(cerroAng) * cerroDist
    const cerroZ = cym + Math.sin(cerroAng) * cerroDist
    const cerro = new THREE.Mesh(new THREE.ConeGeometry(1, 1, 7), hillMat)
    cerro.scale.set(900, 260, 700)
    cerro.position.set(cerroX, 130, cerroZ)
    this.scene.add(cerro)
    const cima = new THREE.Mesh(new THREE.ConeGeometry(1, 1, 7), snowMat)
    cima.scale.set(900 * 0.3, 260 * 0.3, 700 * 0.3)
    cima.position.set(cerroX, 260 - 260 * 0.15, cerroZ)
    this.scene.add(cima)
    for (let k = 0; k < 6; k++) {
      const h = new THREE.Mesh(new THREE.ConeGeometry(1, 1, 6), hillMat)
      const w = 500 + rnd() * 500
      const hh = 60 + rnd() * 60
      h.scale.set(w, hh, w * 0.7)
      h.position.set(cerroX + (rnd() - 0.5) * 2400, hh / 2, cerroZ + (rnd() - 0.5) * 500)
      this.scene.add(h)
    }
  }

  /** Marcas de neumáticos que van quedando en la tierra. */
  private buildMarks(carCount: number) {
    const geo = new THREE.PlaneGeometry(0.34, 0.9)
    geo.rotateX(-Math.PI / 2)
    const mat = new THREE.MeshBasicMaterial({ color: 0x6b5138, transparent: true, opacity: 0.35, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2 })
    this.marks = new THREE.InstancedMesh(geo, mat, carCount * MARKS_PER_CAR * 2)
    const hidden = new THREE.Matrix4().makeScale(0, 0, 0)
    for (let i = 0; i < this.marks.count; i++) this.marks.setMatrixAt(i, hidden)
    this.marks.renderOrder = 2
    this.scene.add(this.marks)
  }

  resize(width: number, height: number, dpr: number) {
    this.renderer.setPixelRatio(dpr)
    this.renderer.setSize(width, height, false)
    this.composer.setPixelRatio(dpr)
    this.composer.setSize(width, height)
    this.bloom.resolution.set(width / 2, height / 2)
    this.camera.aspect = width / height
    this.camera.updateProjectionMatrix()
  }

  update(cars: Car[], player: Car, dt: number) {
    this.time += dt
    // Humo de los asados: sube, se abre y se desvanece en ciclo.
    for (const sp of this.smoke) {
      const a = ((this.time * 0.18 + (sp.userData.phase as number)) % 1)
      const base = sp.userData.base as THREE.Vector3
      sp.position.set(base.x + (sp.userData.drift as number) * a * 6, base.y + a * 7, base.z + a * 2)
      sp.scale.setScalar(0.6 + a * 3.5)
      ;(sp.material as THREE.SpriteMaterial).opacity = 0.4 * (1 - a) * Math.min(1, a * 6)
    }
    for (const f of this.flags) {
      f.rotation.y = Math.sin(this.time * 2 + (f.userData.phase as number)) * 0.25
      f.rotation.z = Math.sin(this.time * 3.1 + (f.userData.phase as number)) * 0.08
    }
    for (const c of cars) {
      const v = this.views.get(c.id)!
      v.group.position.set(c.x, 0, c.y)
      v.group.rotation.y = -c.heading
      v.body.rotation.x = THREE.MathUtils.lerp(v.body.rotation.x, -c.lateralSpeed * 0.02, 0.2)
      v.body.rotation.z = THREE.MathUtils.lerp(v.body.rotation.z, c.speed * 0.002, 0.2)
      for (const fw of v.frontWheels) fw.rotation.y = -c.steerAngle
      const spin = (c.speed * dt) / 0.36
      for (const w of v.wheels) w.rotation.z -= spin
      this.updateDust(c, v, dt)
      this.updateMarks(c, v, dt)
    }

    // Cámara: campo visual que se abre con la velocidad y leve vibración en la tierra.
    const fx = Math.cos(player.heading)
    const fz = Math.sin(player.heading)
    let desired: THREE.Vector3
    let look: THREE.Vector3
    if (this.cameraMode === 'far') {
      desired = new THREE.Vector3(player.x - fx * 16, 9, player.y - fz * 16)
      look = new THREE.Vector3(player.x + fx * 8, 0.5, player.y + fz * 8)
    } else if (this.cameraMode === 'hood') {
      desired = new THREE.Vector3(player.x - fx * 0.3, 1.55, player.y - fz * 0.3)
      look = new THREE.Vector3(player.x + fx * 30, 1.0, player.y + fz * 30)
    } else {
      const back = 7.5 + player.speed * 0.06
      desired = new THREE.Vector3(player.x - fx * back, 2.8 + player.speed * 0.01, player.y - fz * back)
      look = new THREE.Vector3(player.x + fx * 6, 0.9, player.y + fz * 6)
    }
    if (this.first) {
      this.camPos.copy(desired)
      this.camTarget.copy(look)
      this.first = false
    } else {
      const k = this.cameraMode === 'hood' ? 1 : 1 - Math.exp(-dt * 6)
      this.camPos.lerp(desired, k)
      this.camTarget.lerp(look, 1 - Math.exp(-dt * 10))
    }
    const shake = (player.onAsphalt ? 0.004 : 0.02) * Math.min(1, player.speed / 15)
    this.camera.position.copy(this.camPos)
    this.camera.position.y += (Math.random() - 0.5) * shake
    this.camera.lookAt(this.camTarget)
    const targetFov = (this.cameraMode === 'hood' ? 70 : 62) + Math.min(14, player.speed * 0.3)
    this.camera.fov += (targetFov - this.camera.fov) * Math.min(1, dt * 3)
    this.camera.updateProjectionMatrix()

    // Sol de tarde, bajo y cálido; la sombra sigue al jugador.
    this.sun.position.set(player.x - 120, 70, player.y - 85)
    this.sun.target.position.set(player.x, 0, player.y)
    this.sun.target.updateMatrixWorld()

    this.composer.render()
  }

  private updateMarks(c: Car, v: CarView, dt: number) {
    if (c.speed < 2) return
    v.markDist += c.speed * dt
    if (v.markDist < 0.9) return
    v.markDist = 0
    const L = CAR_SPEC.lengthM
    const W = CAR_SPEC.widthM
    const fx = Math.cos(c.heading)
    const fz = Math.sin(c.heading)
    this.tmpQuat.setFromAxisAngle(new THREE.Vector3(0, 1, 0), -c.heading + Math.PI / 2)
    // Marcas más fuertes derrapando o en el pasto.
    const strength = Math.min(1, 0.6 + Math.abs(c.lateralSpeed) * 0.15)
    this.tmpScale.set(strength, 1, 1)
    for (const side of [-1, 1]) {
      const slot = c.id * MARKS_PER_CAR * 2 + (v.markIndex % (MARKS_PER_CAR * 2))
      v.markIndex++
      this.tmpPos.set(c.x - fx * L * 0.4 - fz * side * W * 0.52, 0.05, c.y - fz * L * 0.4 + fx * side * W * 0.52)
      this.tmpMatrix.compose(this.tmpPos, this.tmpQuat, this.tmpScale)
      this.marks.setMatrixAt(slot, this.tmpMatrix)
    }
    this.marks.instanceMatrix.needsUpdate = true
  }

  private updateDust(c: Car, v: CarView, dt: number) {
    const sliding = Math.abs(c.lateralSpeed) > 1.5
    const rate = c.speed > 4 ? (sliding ? 80 : 26) * (c.onAsphalt ? 1 : 1.6) : 0
    v.dustNext -= dt
    if (rate > 0 && v.dustNext <= 0) {
      v.dustNext = 1 / rate
      let sprite: THREE.Sprite | undefined
      let idx = v.dustAge.findIndex((a) => a >= 1)
      if (idx === -1 && v.dust.length < 64) {
        sprite = new THREE.Sprite(this.dustMat.clone())
        this.scene.add(sprite)
        v.dust.push(sprite)
        v.dustAge.push(0)
        idx = v.dust.length - 1
      } else if (idx !== -1) {
        sprite = v.dust[idx]
        v.dustAge[idx] = 0
      }
      if (sprite) {
        const side = Math.random() < 0.5 ? -1 : 1
        const fx = Math.cos(c.heading)
        const fz = Math.sin(c.heading)
        sprite.position.set(c.x - fx * 1.5 - fz * side * 0.9, 0.35, c.y - fz * 1.5 + fx * side * 0.9)
        sprite.scale.setScalar(0.9)
        sprite.userData.drift = (Math.random() - 0.5) * 1.5
      }
    }
    for (let i = 0; i < v.dust.length; i++) {
      if (v.dustAge[i] >= 1) {
        v.dust[i].visible = false
        continue
      }
      v.dustAge[i] += dt / 1.8
      const a = v.dustAge[i]
      const s = v.dust[i]
      s.visible = true
      s.position.y += dt * 1.1
      s.position.x += (s.userData.drift as number) * dt
      s.scale.setScalar(0.9 + a * 5)
      ;(s.material as THREE.SpriteMaterial).opacity = 0.5 * (1 - a) * (1 - a)
    }
  }

  dispose() {
    this.renderer.dispose()
  }
}
