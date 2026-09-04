import * as THREE from 'three'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'

// ---------------------------------------------------------------------------
// Público: figuras humanas instanciadas con siluetas torneadas (hombros,
// cintura, cadera, piernas afinadas), ropa con textura (remera, camiseta a
// rayas, campera), caras con ojos y boca, orejas, barba o anteojos de sol,
// pelo corto o largo, gorra con visera o sombrero de ala, y mate con termo en
// la mano de algunos. Poses y animación de caminar y correr. Todo va en unas
// pocas InstancedMesh para que cientos de personas cuesten poco.
// ---------------------------------------------------------------------------

export const SKIN_TONES = [0xf1c9a5, 0xe6b48c, 0xd9a072, 0xc8956c, 0xb07d50, 0x8d5c33, 0x6b4423]
export const HAIR_COLORS = [0x1a1410, 0x241a12, 0x3b2616, 0x5a3a22, 0x7a5230, 0xa87d4c, 0x8c8c8c, 0xd8c8a0]

/** Postura de brazos en reposo. */
export type Pose = 'down' | 'crossed' | 'hips' | 'phone' | 'cheer' | 'mate'

export interface Person {
  // Lugar propio (a donde vuelve después de correr).
  hx: number
  hz: number
  hy: number
  hrot: number
  // Estado actual.
  x: number
  z: number
  y: number
  rot: number
  // Aspecto.
  h: number // escala de altura (1 = 1,7 m aprox.)
  build: number // ancho del cuerpo
  shirt: number
  shirtStyle: number // 0 remera lisa, 1 camiseta a rayas, 2 campera
  pants: number
  skin: number
  hair: number
  hairLong: boolean
  headStyle: number // 0 normal, 1 barba, 2 anteojos de sol
  hat: number // 0 sin nada, 1 gorra con visera, 2 sombrero de ala
  cap: number // color de la gorra o el sombrero
  sleeves: boolean // mangas largas (antebrazo del color de la remera)
  pose: Pose
  fixed: boolean // no se mueve (arriba de un camión, etc.)
  // Animación.
  swing: number // balanceo de piernas y brazos (-1..1)
  lean: number // inclinación del cuerpo hacia adelante (rad), al correr
  wave: number // brazo levantado (0..1) para los que alientan
  // Movimiento.
  mode: 'idle' | 'walk' | 'flee' | 'wait' | 'return'
  walk?: { dx: number; dz: number; amp: number; speed: number; phase: number }
  vx: number
  vz: number
  timer: number
  hint: number // índice de pista aproximado, para consultar la altura del terreno
  dirty: boolean
}

// --- Texturas dibujadas (en blanco y grises: el color de instancia las tiñe) ---

function tex(w: number, h: number, draw: (ctx: CanvasRenderingContext2D) => void): THREE.CanvasTexture {
  const c = document.createElement('canvas')
  c.width = w
  c.height = h
  const ctx = c.getContext('2d')!
  draw(ctx)
  const t = new THREE.CanvasTexture(c)
  t.colorSpace = THREE.SRGBColorSpace
  t.wrapS = THREE.RepeatWrapping
  return t
}

/** Pliegues suaves: franjas verticales tenues, para que la tela no sea plana. */
function folds(ctx: CanvasRenderingContext2D, w: number, h: number, n: number, strength: number, seed: number) {
  let s = seed
  const rnd = () => {
    s = (s * 1664525 + 1013904223) % 4294967296
    return s / 4294967296
  }
  for (let i = 0; i < n; i++) {
    const x = rnd() * w
    const wd = 4 + rnd() * 14
    const g = ctx.createLinearGradient(x - wd, 0, x + wd, 0)
    const k = strength * (0.5 + rnd() * 0.5)
    g.addColorStop(0, 'rgba(0,0,0,0)')
    g.addColorStop(0.5, `rgba(0,0,0,${k})`)
    g.addColorStop(1, 'rgba(0,0,0,0)')
    ctx.fillStyle = g
    ctx.fillRect(x - wd, 0, wd * 2, h)
  }
}

/** Torso: la textura envuelve el cuerpo (u alrededor, v de la cadera al cuello). */
function makeShirtTexture(style: number): THREE.CanvasTexture {
  return tex(256, 256, (ctx) => {
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, 256, 256)
    folds(ctx, 256, 256, 9, 0.16, 7 + style)
    if (style === 1) {
      // Camiseta a rayas horizontales.
      ctx.fillStyle = 'rgba(0,0,0,0.62)'
      for (let y = 30; y < 230; y += 40) ctx.fillRect(0, y, 256, 20)
    }
    if (style === 2) {
      // Campera: cierre al frente, bolsillos y puños más oscuros.
      ctx.fillStyle = 'rgba(0,0,0,0.25)'
      ctx.fillRect(0, 0, 256, 256)
      ctx.fillStyle = 'rgba(0,0,0,0.5)'
      ctx.fillRect(126, 20, 4, 236)
      ctx.strokeStyle = 'rgba(0,0,0,0.45)'
      ctx.lineWidth = 2
      ctx.strokeRect(70, 60, 30, 4)
      ctx.strokeRect(156, 60, 30, 4)
      ctx.fillStyle = 'rgba(0,0,0,0.35)'
      ctx.fillRect(0, 0, 256, 12)
    }
    // Cuello más oscuro y dobladillo abajo.
    ctx.fillStyle = 'rgba(0,0,0,0.35)'
    ctx.fillRect(0, 246, 256, 10)
    ctx.fillStyle = 'rgba(0,0,0,0.18)'
    ctx.fillRect(0, 0, 256, 6)
    // Sombra bajo el pecho, para dar volumen.
    const g = ctx.createLinearGradient(0, 120, 0, 200)
    g.addColorStop(0, 'rgba(0,0,0,0)')
    g.addColorStop(1, 'rgba(0,0,0,0.12)')
    ctx.fillStyle = g
    ctx.fillRect(0, 120, 256, 80)
  })
}

function makePantsTexture(): THREE.CanvasTexture {
  return tex(128, 256, (ctx) => {
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, 128, 256)
    folds(ctx, 128, 256, 5, 0.14, 3)
    // Costura lateral y rodilla.
    ctx.fillStyle = 'rgba(0,0,0,0.3)'
    ctx.fillRect(62, 0, 3, 256)
    ctx.fillStyle = 'rgba(0,0,0,0.08)'
    ctx.fillRect(0, 118, 128, 14)
  })
}

/** Cara: la esfera de Three pone u = 0,5 al frente (+x local). */
function makeFaceTexture(style: number): THREE.CanvasTexture {
  return tex(256, 128, (ctx) => {
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, 256, 128)
    // Sombra bajo el mentón y en la nuca.
    ctx.fillStyle = 'rgba(0,0,0,0.12)'
    ctx.fillRect(0, 108, 256, 20)
    const cx = 128
    // Cejas
    ctx.fillStyle = 'rgba(40,25,15,0.85)'
    ctx.fillRect(cx - 24, 50, 15, 3)
    ctx.fillRect(cx + 9, 50, 15, 3)
    if (style === 2) {
      // Anteojos de sol: banda oscura con dos lentes.
      ctx.fillStyle = '#101010'
      ctx.fillRect(cx - 30, 55, 60, 3)
      ctx.beginPath()
      ctx.ellipse(cx - 15, 60, 11, 7, 0, 0, Math.PI * 2)
      ctx.ellipse(cx + 15, 60, 11, 7, 0, 0, Math.PI * 2)
      ctx.fill()
    } else {
      // Ojos: blanco, iris y pupila.
      for (const ex of [cx - 15, cx + 15]) {
        ctx.fillStyle = '#f4f4f4'
        ctx.beginPath()
        ctx.ellipse(ex, 60, 6, 3.6, 0, 0, Math.PI * 2)
        ctx.fill()
        ctx.fillStyle = '#3a2a1a'
        ctx.beginPath()
        ctx.arc(ex, 60, 2.6, 0, Math.PI * 2)
        ctx.fill()
        ctx.fillStyle = '#000'
        ctx.beginPath()
        ctx.arc(ex, 60, 1.2, 0, Math.PI * 2)
        ctx.fill()
      }
    }
    // Nariz: sombra suave a un lado.
    ctx.fillStyle = 'rgba(0,0,0,0.12)'
    ctx.fillRect(cx + 1, 62, 4, 14)
    // Boca.
    ctx.strokeStyle = 'rgba(120,50,45,0.9)'
    ctx.lineWidth = 2
    ctx.beginPath()
    ctx.moveTo(cx - 8, 86)
    ctx.quadraticCurveTo(cx, 90, cx + 8, 86)
    ctx.stroke()
    if (style === 1) {
      // Barba: mandíbula y bigote más oscuros.
      ctx.fillStyle = 'rgba(30,20,12,0.6)'
      ctx.beginPath()
      ctx.ellipse(cx, 96, 34, 18, 0, 0, Math.PI)
      ctx.fill()
      ctx.fillRect(cx - 12, 78, 24, 5)
    }
  })
}

function makeHatTexture(): THREE.CanvasTexture {
  return tex(128, 64, (ctx) => {
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, 128, 64)
    // Costuras de los gajos.
    ctx.fillStyle = 'rgba(0,0,0,0.3)'
    for (let x = 0; x < 128; x += 21) ctx.fillRect(x, 0, 2, 64)
  })
}

// --- Geometrías ---

function withColor(geo: THREE.BufferGeometry, k: number): THREE.BufferGeometry {
  const n = geo.getAttribute('position').count
  const col = new Float32Array(n * 3)
  col.fill(k)
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3))
  return geo
}

function merged(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const g = mergeGeometries(parts, false)
  parts.forEach((p) => p.dispose())
  return g
}

/** Torso torneado: cadera, cintura, pecho, hombros y cuello; centrado en la cadera (y = 0). */
function torsoGeometry(): THREE.BufferGeometry {
  const prof: [number, number][] = [
    [0.0, 0.0],
    [0.16, 0.0],
    [0.175, 0.08],
    [0.16, 0.2],
    [0.175, 0.34],
    [0.195, 0.46],
    [0.205, 0.54],
    [0.19, 0.6],
    [0.12, 0.64],
    [0.06, 0.66],
    [0.0, 0.66],
  ]
  const pts = prof.map(([r, y]) => new THREE.Vector2(r, y))
  const g = new THREE.LatheGeometry(pts, 18)
  g.scale(0.62, 1, 1)
  // La costura de la textura (u = 0) queda atrás; el centro u = 0,5 al frente (+x).
  g.rotateY(-Math.PI / 2)
  return g
}

/** Pierna torneada (muslo, rodilla, tobillo) con zapatilla, del piso (y = 0) a la cadera. */
function legGeometry(): THREE.BufferGeometry {
  const prof: [number, number][] = [
    [0.0, 0.07],
    [0.05, 0.07],
    [0.055, 0.2],
    [0.062, 0.38],
    [0.075, 0.55],
    [0.085, 0.72],
    [0.07, 0.8],
    [0.0, 0.8],
  ]
  const leg = new THREE.LatheGeometry(
    prof.map(([r, y]) => new THREE.Vector2(r, y)),
    12,
  )
  const shoe = new THREE.BoxGeometry(0.26, 0.08, 0.12)
  shoe.translate(0.05, 0.04, 0)
  const toe = new THREE.SphereGeometry(0.06, 8, 6)
  toe.scale(1, 0.65, 1)
  toe.translate(0.17, 0.04, 0)
  return merged([withColor(leg, 1), withColor(shoe, 0.22), withColor(toe, 0.22)])
}

/** Cabeza con orejas y cuello; la cara mira a +x local. */
function headGeometry(): THREE.BufferGeometry {
  const skull = new THREE.SphereGeometry(0.115, 18, 14)
  skull.scale(0.95, 1.12, 0.92)
  const neck = new THREE.CylinderGeometry(0.045, 0.052, 0.12, 8)
  neck.translate(0, -0.12, 0)
  const neckUv = neck.getAttribute('uv') as THREE.BufferAttribute
  for (let i = 0; i < neckUv.count; i++) neckUv.setXY(i, 0.02, 0.85)
  const ears: THREE.BufferGeometry[] = []
  for (const side of [-1, 1]) {
    const ear = new THREE.SphereGeometry(0.028, 8, 6)
    ear.scale(0.6, 1, 1)
    ear.translate(0, -0.01, side * 0.108)
    const uv = ear.getAttribute('uv') as THREE.BufferAttribute
    for (let i = 0; i < uv.count; i++) uv.setXY(i, 0.02, 0.3)
    ears.push(ear)
  }
  return merged([skull, neck, ...ears])
}

/** Gorra con visera. */
function capGeometry(): THREE.BufferGeometry {
  const dome = new THREE.SphereGeometry(0.124, 16, 8, 0, Math.PI * 2, 0, Math.PI * 0.5)
  dome.scale(0.98, 1.05, 0.95)
  const visor = new THREE.BoxGeometry(0.13, 0.016, 0.16)
  visor.translate(0.15, 0.0, 0)
  const visorUv = visor.getAttribute('uv') as THREE.BufferAttribute
  for (let i = 0; i < visorUv.count; i++) visorUv.setXY(i, 0.5, 0.5)
  return merged([dome, visor])
}

/** Sombrero de ala: copa baja y ala ancha. */
function hatGeometry(): THREE.BufferGeometry {
  const crown = new THREE.CylinderGeometry(0.11, 0.125, 0.09, 16)
  crown.translate(0, 0.045, 0)
  const top = new THREE.SphereGeometry(0.11, 16, 6, 0, Math.PI * 2, 0, Math.PI * 0.4)
  top.scale(1, 0.5, 1)
  top.translate(0, 0.09, 0)
  const brim = new THREE.CylinderGeometry(0.2, 0.21, 0.012, 20)
  brim.translate(0, 0.0, 0)
  return merged([crown, top, brim])
}

const Y_AXIS = new THREE.Vector3(0, 1, 0)
const Z_AXIS = new THREE.Vector3(0, 0, 1)
const X_AXIS = new THREE.Vector3(1, 0, 0)

/** Ángulos de brazo por postura: [hombro adelante, hombro afuera, codo] para cada lado. */
function armPose(pose: Pose, side: number, wave: number, t: number): [number, number, number] {
  switch (pose) {
    case 'crossed':
      return [0.55, side * 0.15, 1.9]
    case 'hips':
      return [-0.15, side * 0.55, 1.6]
    case 'phone':
      return [1.05 + side * 0.05, side * 0.12, 1.35]
    case 'mate':
      // Derecha con el mate a la altura del pecho; izquierda con el termo bajo el brazo.
      if (side > 0) return [0.75, 0.05, 1.75]
      return [0.15, -0.05, 1.5]
    case 'cheer':
      if (side > 0) return [2.7 + Math.sin(t * 9) * 0.25 * wave, 0.35, 0.4 + Math.sin(t * 9) * 0.3]
      return [0.15, side * 0.15, 0.3]
    default:
      return [0.05, side * 0.08, 0.25]
  }
}

export class CrowdPeople {
  readonly group = new THREE.Group()
  private legs: THREE.InstancedMesh
  private torsos: THREE.InstancedMesh[]
  private upperArm: THREE.InstancedMesh
  private foreArm: THREE.InstancedMesh
  private heads: THREE.InstancedMesh[]
  private hairShort: THREE.InstancedMesh
  private hairLong: THREE.InstancedMesh
  private hats: THREE.InstancedMesh[]
  private mate: THREE.InstancedMesh
  private termo: THREE.InstancedMesh
  private phone: THREE.InstancedMesh
  private meshes: THREE.InstancedMesh[]
  private m = new THREE.Matrix4()
  private q = new THREE.Quaternion()
  private q2 = new THREE.Quaternion()
  private q3 = new THREE.Quaternion()
  private p = new THREE.Vector3()
  private v = new THREE.Vector3()
  private sc = new THREE.Vector3()
  private col = new THREE.Color()
  private hidden = new THREE.Matrix4().makeScale(0, 0, 0)

  constructor(count: number) {
    const cloth = (map?: THREE.Texture) => new THREE.MeshStandardMaterial({ roughness: 0.92, map })
    this.legs = new THREE.InstancedMesh(legGeometry(), new THREE.MeshStandardMaterial({ roughness: 0.92, vertexColors: true, map: makePantsTexture() }), count * 2)
    const torsoGeo = torsoGeometry()
    this.torsos = [0, 1, 2].map((style) => new THREE.InstancedMesh(torsoGeo, cloth(makeShirtTexture(style)), count))
    // Brazo: hombro-codo (manga, color de remera) y codo-mano (piel o manga larga).
    const upperGeo = new THREE.CapsuleGeometry(0.056, 0.2, 3, 8)
    upperGeo.translate(0, -0.13, 0)
    const foreCap = new THREE.CapsuleGeometry(0.046, 0.2, 3, 8)
    foreCap.translate(0, -0.12, 0)
    const hand = new THREE.SphereGeometry(0.05, 8, 6)
    hand.scale(1.1, 1, 0.7)
    hand.translate(0, -0.27, 0)
    this.upperArm = new THREE.InstancedMesh(upperGeo, cloth(), count * 2)
    this.foreArm = new THREE.InstancedMesh(merged([foreCap, hand]), new THREE.MeshStandardMaterial({ roughness: 0.85 }), count * 2)
    const headGeo = headGeometry()
    this.heads = [0, 1, 2].map((style) => new THREE.InstancedMesh(headGeo, new THREE.MeshStandardMaterial({ roughness: 0.8, map: makeFaceTexture(style) }), count))
    // Pelo corto: casquete; pelo largo: casquete más la nuca hasta los hombros.
    const hairShortGeo = new THREE.SphereGeometry(0.122, 14, 8, 0, Math.PI * 2, 0, Math.PI * 0.55)
    hairShortGeo.scale(0.98, 1.1, 0.95)
    const hairTop = new THREE.SphereGeometry(0.122, 14, 8, 0, Math.PI * 2, 0, Math.PI * 0.5)
    hairTop.scale(0.98, 1.1, 0.95)
    const hairBack = new THREE.SphereGeometry(0.125, 14, 10, -Math.PI / 2, Math.PI, Math.PI * 0.45, Math.PI * 0.5)
    hairBack.scale(0.98, 1.6, 0.95)
    this.hairShort = new THREE.InstancedMesh(hairShortGeo, new THREE.MeshStandardMaterial({ roughness: 0.95 }), count)
    this.hairLong = new THREE.InstancedMesh(merged([hairTop, hairBack]), new THREE.MeshStandardMaterial({ roughness: 0.95 }), count)
    const hatTex = makeHatTexture()
    this.hats = [new THREE.InstancedMesh(capGeometry(), cloth(hatTex), count), new THREE.InstancedMesh(hatGeometry(), cloth(), count)]
    // Mate (con bombilla), termo y celular.
    const mateCup = new THREE.CylinderGeometry(0.035, 0.028, 0.075, 10)
    const bombilla = new THREE.CylinderGeometry(0.004, 0.004, 0.14, 5)
    bombilla.rotateZ(0.35)
    bombilla.translate(0.02, 0.09, 0)
    this.mate = new THREE.InstancedMesh(merged([withColor(mateCup, 1), withColor(bombilla, 0.6)]), new THREE.MeshStandardMaterial({ color: 0x8a6a3a, roughness: 0.7, vertexColors: true, metalness: 0.3 }), count)
    const termoBody = new THREE.CylinderGeometry(0.045, 0.045, 0.3, 12)
    const termoCap = new THREE.CylinderGeometry(0.03, 0.045, 0.05, 12)
    termoCap.translate(0, 0.175, 0)
    this.termo = new THREE.InstancedMesh(merged([withColor(termoBody, 1), withColor(termoCap, 0.25)]), new THREE.MeshStandardMaterial({ roughness: 0.4, metalness: 0.5, vertexColors: true }), count)
    this.phone = new THREE.InstancedMesh(new THREE.BoxGeometry(0.015, 0.14, 0.07), new THREE.MeshStandardMaterial({ color: 0x151515, roughness: 0.3, metalness: 0.4 }), count)
    this.meshes = [this.legs, ...this.torsos, this.upperArm, this.foreArm, ...this.heads, this.hairShort, this.hairLong, ...this.hats, this.mate, this.termo, this.phone]
    for (const mesh of this.meshes) {
      mesh.castShadow = true
      mesh.frustumCulled = false
      this.group.add(mesh)
    }
  }

  /** Vuelca la pose actual de la persona `i` en los buffers de instancias. */
  setPerson(i: number, s: Person, t: number) {
    const { x, z, rot, h } = s
    const y0 = s.y
    const cos = Math.cos(rot)
    const sin = Math.sin(rot)
    const w = s.build
    // Un punto en el espacio local de la persona (adelante = +x local) a mundo.
    const local = (lx: number, ly: number, lz: number) => this.p.set(x + (lx * cos + lz * sin) * w, y0 + ly * h, z + (-lx * sin + lz * cos) * w)
    const base = this.q.setFromAxisAngle(Y_AXIS, rot)
    // Inclinación al correr: el cuerpo gira alrededor de la cadera.
    const leanQ = this.q3.setFromAxisAngle(Z_AXIS, s.lean)
    const bodyQ = this.q2.copy(base).multiply(leanQ)

    // Piernas: balanceo opuesto alrededor de la cadera.
    for (const side of [-1, 1]) {
      const k = i * 2 + (side > 0 ? 1 : 0)
      const legQ = new THREE.Quaternion().setFromAxisAngle(Z_AXIS, side * s.swing * 0.7)
      const qq = base.clone().multiply(legQ)
      local(0, 0, side * 0.095)
      this.sc.set(w, h, w)
      this.legs.setMatrixAt(k, this.m.compose(this.p, qq, this.sc))
      this.legs.setColorAt(k, this.col.setHex(s.pants))
    }
    // Torso (una de las tres variantes de ropa).
    const hipY = 0.78
    local(Math.sin(s.lean) * 0.02, hipY - 0.02, 0)
    this.sc.set(w, h, w)
    this.torsos.forEach((mesh, style) => {
      if (style === s.shirtStyle) {
        mesh.setMatrixAt(i, this.m.compose(this.p, bodyQ, this.sc))
        mesh.setColorAt(i, this.col.setHex(s.shirt))
      } else mesh.setMatrixAt(i, this.hidden)
    })

    // Brazos: hombro en lo alto del torso; el balanceo va opuesto a la pierna.
    const shoulderY = hipY + Math.cos(s.lean) * 0.56
    const shoulderX = Math.sin(s.lean) * 0.56
    for (const side of [-1, 1]) {
      const k = i * 2 + (side > 0 ? 1 : 0)
      const [fwd, out, elbow] = armPose(s.pose, side, s.wave, t)
      const swing = -side * s.swing * 0.8
      const shoulderQ = new THREE.Quaternion().setFromAxisAngle(Z_AXIS, fwd + swing)
      shoulderQ.multiply(new THREE.Quaternion().setFromAxisAngle(X_AXIS, -side * out))
      const upperQ = bodyQ.clone().multiply(shoulderQ)
      local(shoulderX, shoulderY, side * 0.215)
      this.sc.set(1, h, 1)
      this.upperArm.setMatrixAt(k, this.m.compose(this.p, upperQ, this.sc))
      this.upperArm.setColorAt(k, this.col.setHex(s.shirt))
      // Antebrazo: cuelga del codo, con flexión.
      const elbowOffset = new THREE.Vector3(0, -0.26 * h, 0).applyQuaternion(upperQ)
      this.p.add(elbowOffset)
      const foreQ = upperQ.multiply(new THREE.Quaternion().setFromAxisAngle(Z_AXIS, elbow))
      this.foreArm.setMatrixAt(k, this.m.compose(this.p, foreQ, this.sc))
      this.foreArm.setColorAt(k, this.col.setHex(s.sleeves ? s.shirt : s.skin))
      // Objetos en la mano derecha (mate, celular) y bajo el brazo izquierdo (termo).
      const handP = this.p.clone().add(this.v.set(0, -0.28 * h, 0).applyQuaternion(foreQ))
      if (side > 0) {
        if (s.pose === 'mate') {
          this.mate.setMatrixAt(i, this.m.compose(handP, bodyQ, this.sc.set(1, 1, 1)))
          this.phone.setMatrixAt(i, this.hidden)
        } else if (s.pose === 'phone') {
          this.phone.setMatrixAt(i, this.m.compose(handP, foreQ, this.sc.set(1, 1, 1)))
          this.mate.setMatrixAt(i, this.hidden)
        } else {
          this.mate.setMatrixAt(i, this.hidden)
          this.phone.setMatrixAt(i, this.hidden)
        }
      } else if (s.pose === 'mate') {
        local(shoulderX + 0.02, shoulderY - 0.2, side * 0.2)
        this.termo.setMatrixAt(i, this.m.compose(this.p, bodyQ, this.sc.set(1, 1, 1)))
        this.termo.setColorAt(i, this.col.setHex([0x2f7a3a, 0xd8d8d8, 0x1f3f8f, 0x8c1d1d][i % 4]))
      } else this.termo.setMatrixAt(i, this.hidden)
    }

    // Cabeza (variante de cara), pelo y gorra o sombrero.
    const headY = hipY + Math.cos(s.lean) * 0.79
    const headX = Math.sin(s.lean) * 0.79
    local(headX, headY, 0)
    this.sc.set(1, 1, 1)
    this.heads.forEach((mesh, style) => {
      if (style === s.headStyle) {
        mesh.setMatrixAt(i, this.m.compose(this.p, bodyQ, this.sc))
        mesh.setColorAt(i, this.col.setHex(s.skin))
      } else mesh.setMatrixAt(i, this.hidden)
    })
    const hairP = this.p.clone()
    const hatP = hairP.clone().add(this.v.set(0, 0.06 * h, 0).applyQuaternion(bodyQ))
    this.hats.forEach((mesh, k) => {
      if (s.hat === k + 1) {
        mesh.setMatrixAt(i, this.m.compose(k === 0 ? hairP : hatP, bodyQ, this.sc))
        mesh.setColorAt(i, this.col.setHex(s.cap))
      } else mesh.setMatrixAt(i, this.hidden)
    })
    // Con sombrero de ala el pelo igual asoma; con gorra, no.
    const showHair = s.hat !== 1
    const target = s.hairLong ? this.hairLong : this.hairShort
    const other = s.hairLong ? this.hairShort : this.hairLong
    if (showHair) {
      target.setMatrixAt(i, this.m.compose(hairP, bodyQ, this.sc))
      target.setColorAt(i, this.col.setHex(s.hair))
    } else target.setMatrixAt(i, this.hidden)
    other.setMatrixAt(i, this.hidden)
  }

  commit() {
    for (const mesh of this.meshes) {
      mesh.instanceMatrix.needsUpdate = true
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true
    }
  }
}

// ---------------------------------------------------------------------------
// Banderillero: una figura sola (mallas comunes, no instanciadas) con la
// bandera a cuadros en la mano derecha. Quieto la tiene enrollada y baja;
// cuando llegan los autos la agita en alto y la tela flamea.
// ---------------------------------------------------------------------------

function makeCheckerTexture(): THREE.CanvasTexture {
  return tex(160, 96, (ctx) => {
    for (let y = 0; y < 6; y++) {
      for (let x = 0; x < 10; x++) {
        ctx.fillStyle = (x + y) % 2 ? '#111111' : '#f4f4f4'
        ctx.fillRect(x * 16, y * 16, 16, 16)
      }
    }
  })
}

export class Flagman {
  readonly group = new THREE.Group()
  private rightArm = new THREE.Group()
  private cloth: THREE.Mesh
  private clothPos: THREE.BufferAttribute
  private clothBase: Float32Array
  private waveAmount = 0
  private phase = Math.random() * 6

  constructor() {
    const skin = new THREE.MeshStandardMaterial({ color: 0xd9a072, roughness: 0.8, map: makeFaceTexture(2) })
    const shirt = new THREE.MeshStandardMaterial({ color: 0xf2f2f2, roughness: 0.9, map: makeShirtTexture(0) })
    const sleeve = new THREE.MeshStandardMaterial({ color: 0xf2f2f2, roughness: 0.9 })
    const pants = new THREE.MeshStandardMaterial({ color: 0x1f1f1f, roughness: 0.9, vertexColors: true, map: makePantsTexture() })
    const capMat = new THREE.MeshStandardMaterial({ color: 0xd42020, roughness: 0.9 })
    const legGeo = legGeometry()
    for (const side of [-1, 1]) {
      const leg = new THREE.Mesh(legGeo, pants)
      leg.position.set(0, 0, side * 0.095)
      leg.castShadow = true
      this.group.add(leg)
    }
    const torso = new THREE.Mesh(torsoGeometry(), shirt)
    torso.position.y = 0.76
    torso.castShadow = true
    this.group.add(torso)
    const head = new THREE.Mesh(headGeometry(), skin)
    head.position.y = 1.57
    head.castShadow = true
    this.group.add(head)
    const cap = new THREE.Mesh(capGeometry(), capMat)
    cap.position.y = 1.57
    this.group.add(cap)
    // Brazos: el izquierdo cuelga; el derecho es un grupo que se anima desde el hombro.
    const upperGeo = new THREE.CapsuleGeometry(0.056, 0.2, 3, 8)
    upperGeo.translate(0, -0.13, 0)
    const foreGeo = new THREE.CapsuleGeometry(0.046, 0.2, 3, 8)
    foreGeo.translate(0, -0.12, 0)
    const left = new THREE.Group()
    left.position.set(0, 1.34, -0.215)
    left.rotation.z = 0.1
    const lu = new THREE.Mesh(upperGeo, sleeve)
    const lf = new THREE.Mesh(foreGeo, skin)
    lf.position.y = -0.26
    lf.rotation.z = 0.3
    left.add(lu, lf)
    this.group.add(left)
    this.rightArm.position.set(0, 1.34, 0.215)
    const ru = new THREE.Mesh(upperGeo, sleeve)
    const fore = new THREE.Group()
    fore.position.y = -0.26
    fore.rotation.z = 0.35
    const rf = new THREE.Mesh(foreGeo, skin)
    fore.add(rf)
    // Mástil agarrado cerca de su base: sigue la línea del antebrazo más allá
    // de la mano (el antebrazo apunta a -y local), con la tela en la punta.
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, 0.8, 6), new THREE.MeshStandardMaterial({ color: 0xdddddd, metalness: 0.5, roughness: 0.4 }))
    pole.position.set(0, -0.28 - 0.25, 0)
    fore.add(pole)
    const clothGeo = new THREE.PlaneGeometry(0.85, 0.55, 12, 6)
    clothGeo.translate(0.425, 0, 0)
    this.cloth = new THREE.Mesh(clothGeo, new THREE.MeshStandardMaterial({ map: makeCheckerTexture(), side: THREE.DoubleSide, roughness: 0.9 }))
    this.cloth.position.set(0, -0.28 - 0.38, 0)
    // La tela sale del mástil hacia el costado de la persona.
    this.cloth.rotation.y = Math.PI / 2
    this.cloth.castShadow = true
    fore.add(this.cloth)
    this.clothPos = this.cloth.geometry.getAttribute('position') as THREE.BufferAttribute
    this.clothBase = new Float32Array(this.clothPos.array as Float32Array)
    this.rightArm.add(ru, fore)
    this.group.add(this.rightArm)
    this.rightArm.rotation.z = 0.15
    for (const m of [ru, rf, lu, lf]) m.castShadow = true
    this.setWave(0)
  }

  /** 0 = bandera enrollada y baja; 1 = agitándola en alto. */
  private setWave(k: number) {
    this.waveAmount = k
    this.cloth.scale.set(1, 0.12 + 0.88 * k, 1)
  }

  update(time: number, dt: number, waving: boolean) {
    const target = waving ? 1 : 0
    this.setWave(this.waveAmount + (target - this.waveAmount) * Math.min(1, dt * 3))
    const k = this.waveAmount
    // Brazo: de colgando (0,15 rad) a en alto (2,4 rad) con vaivén adelante-atrás y lateral.
    const swing = Math.sin(time * 7 + this.phase)
    this.rightArm.rotation.z = 0.15 + k * (2.25 + swing * 0.35)
    this.rightArm.rotation.x = k * Math.cos(time * 7 + this.phase) * 0.55
    // Tela: ondas que crecen hacia la punta, más fuertes agitando.
    const pos = this.clothPos
    const base = this.clothBase
    const amp = 0.02 + 0.07 * k
    const speed = 6 + 10 * k
    for (let i = 0; i < pos.count; i++) {
      const x = base[i * 3]
      const y = base[i * 3 + 1]
      const ripple = Math.sin(x * 9 - time * speed + y * 3) * amp * (x / 0.85) + Math.sin(x * 4 + time * 3.1) * amp * 0.4 * (x / 0.85)
      pos.setZ(i, ripple)
    }
    pos.needsUpdate = true
    this.cloth.geometry.computeVertexNormals()
  }
}
