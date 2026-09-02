import * as THREE from 'three'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'

// ---------------------------------------------------------------------------
// Público: figuras humanas instanciadas (piernas, torso, brazos con antebrazo,
// cabeza con cara, pelo o gorra con visera), con poses y animación de caminar
// y correr. Todo va en unas pocas InstancedMesh para que cientos de personas
// cuesten poco.
// ---------------------------------------------------------------------------

export const SKIN_TONES = [0xf1c9a5, 0xe6b48c, 0xd9a072, 0xc8956c, 0xb07d50, 0x8d5c33, 0x6b4423]
export const HAIR_COLORS = [0x1a1410, 0x241a12, 0x3b2616, 0x5a3a22, 0x7a5230, 0xa87d4c, 0x8c8c8c, 0xd8c8a0]

/** Postura de brazos en reposo. */
export type Pose = 'down' | 'crossed' | 'hips' | 'phone' | 'cheer'

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
  pants: number
  skin: number
  hair: number
  hairLong: boolean
  cap: number // -1 sin gorra
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

function makeFaceTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas')
  c.width = 128
  c.height = 64
  const ctx = c.getContext('2d')!
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, 128, 64)
  // La cara mira a +x local, que en la esfera de Three cae en u = 0,5.
  ctx.fillStyle = '#3a2a20'
  // Cejas
  ctx.fillRect(56, 27, 6, 2)
  ctx.fillRect(66, 27, 6, 2)
  // Ojos
  ctx.beginPath()
  ctx.ellipse(59, 32, 2, 1.6, 0, 0, Math.PI * 2)
  ctx.ellipse(69, 32, 2, 1.6, 0, 0, Math.PI * 2)
  ctx.fill()
  // Boca
  ctx.strokeStyle = '#7a4a3a'
  ctx.lineWidth = 1.4
  ctx.beginPath()
  ctx.moveTo(60, 41)
  ctx.quadraticCurveTo(64, 43, 68, 41)
  ctx.stroke()
  const tex = new THREE.CanvasTexture(c)
  tex.colorSpace = THREE.SRGBColorSpace
  return tex
}

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
  private torso: THREE.InstancedMesh
  private upperArm: THREE.InstancedMesh
  private foreArm: THREE.InstancedMesh
  private head: THREE.InstancedMesh
  private hairShort: THREE.InstancedMesh
  private hairLong: THREE.InstancedMesh
  private cap: THREE.InstancedMesh
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
    // Piernas: cápsula (pantalón) más zapatilla oscura, con color por vértice
    // que multiplica el color de instancia.
    const legCap = new THREE.CapsuleGeometry(0.072, 0.62, 3, 8)
    legCap.translate(0, 0.45, 0)
    const shoe = new THREE.BoxGeometry(0.26, 0.09, 0.13)
    shoe.translate(0.05, 0.045, 0)
    const legGeo = merged([withColor(legCap, 1), withColor(shoe, 0.22)])

    // Torso: cápsula achatada, con hombros redondeados.
    const torsoGeo = new THREE.CapsuleGeometry(0.19, 0.26, 4, 12)
    torsoGeo.scale(0.7, 1, 1)
    // Brazo: hombro-codo (manga, color de remera) y codo-mano (piel o manga larga).
    const upperGeo = new THREE.CapsuleGeometry(0.058, 0.2, 3, 8)
    upperGeo.translate(0, -0.13, 0)
    const foreCap = new THREE.CapsuleGeometry(0.05, 0.2, 3, 8)
    foreCap.translate(0, -0.12, 0)
    const hand = new THREE.SphereGeometry(0.052, 8, 6)
    hand.scale(1.1, 1, 0.7)
    hand.translate(0, -0.27, 0)
    const foreGeo = merged([foreCap, hand])
    // Cabeza con cuello; la cara es una textura sobre la esfera.
    const skull = new THREE.SphereGeometry(0.115, 14, 12)
    skull.scale(0.95, 1.1, 0.9)
    const neck = new THREE.CylinderGeometry(0.045, 0.05, 0.12, 8)
    neck.translate(0, -0.12, 0)
    // La cara usa uv; el cuello sin cara (uv fuera del dibujo: blanco).
    const neckUv = neck.getAttribute('uv') as THREE.BufferAttribute
    for (let i = 0; i < neckUv.count; i++) neckUv.setXY(i, 0.02, 0.02)
    const headGeo = merged([skull, neck])
    // Pelo corto: casquete; pelo largo: casquete más la nuca hasta los hombros.
    const hairShortGeo = new THREE.SphereGeometry(0.122, 14, 8, 0, Math.PI * 2, 0, Math.PI * 0.52)
    hairShortGeo.scale(0.98, 1.1, 0.95)
    const hairTop = new THREE.SphereGeometry(0.122, 14, 8, 0, Math.PI * 2, 0, Math.PI * 0.5)
    hairTop.scale(0.98, 1.1, 0.95)
    const hairBack = new THREE.SphereGeometry(0.125, 14, 10, -Math.PI / 2, Math.PI, Math.PI * 0.45, Math.PI * 0.5)
    hairBack.scale(0.98, 1.6, 0.95)
    const hairLongGeo = merged([hairTop, hairBack])
    // Gorra: casquete con visera al frente (+x local).
    const capDome = new THREE.SphereGeometry(0.125, 14, 8, 0, Math.PI * 2, 0, Math.PI * 0.5)
    capDome.scale(0.98, 1.05, 0.95)
    const visor = new THREE.BoxGeometry(0.13, 0.018, 0.17)
    visor.translate(0.14, 0.0, 0)
    const capGeo = merged([capDome, visor])

    const cloth = () => new THREE.MeshStandardMaterial({ roughness: 0.92 })
    this.legs = new THREE.InstancedMesh(legGeo, new THREE.MeshStandardMaterial({ roughness: 0.92, vertexColors: true }), count * 2)
    this.torso = new THREE.InstancedMesh(torsoGeo, cloth(), count)
    this.upperArm = new THREE.InstancedMesh(upperGeo, cloth(), count * 2)
    this.foreArm = new THREE.InstancedMesh(foreGeo, new THREE.MeshStandardMaterial({ roughness: 0.85 }), count * 2)
    this.head = new THREE.InstancedMesh(headGeo, new THREE.MeshStandardMaterial({ roughness: 0.8, map: makeFaceTexture() }), count)
    this.hairShort = new THREE.InstancedMesh(hairShortGeo, new THREE.MeshStandardMaterial({ roughness: 0.95 }), count)
    this.hairLong = new THREE.InstancedMesh(hairLongGeo, new THREE.MeshStandardMaterial({ roughness: 0.95 }), count)
    this.cap = new THREE.InstancedMesh(capGeo, cloth(), count)
    this.meshes = [this.legs, this.torso, this.upperArm, this.foreArm, this.head, this.hairShort, this.hairLong, this.cap]
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
      local(0, 0, side * 0.1)
      this.sc.set(w, h, w)
      this.legs.setMatrixAt(k, this.m.compose(this.p, qq, this.sc))
      this.legs.setColorAt(k, this.col.setHex(s.pants))
    }
    // Torso.
    const hipY = 0.78
    const torsoOff = this.v.set(Math.sin(s.lean) * 0.32, hipY + Math.cos(s.lean) * 0.32, 0)
    local(torsoOff.x, torsoOff.y, 0)
    this.sc.set(w, h, w)
    this.torso.setMatrixAt(i, this.m.compose(this.p, bodyQ, this.sc))
    this.torso.setColorAt(i, this.col.setHex(s.shirt))

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
      local(shoulderX, shoulderY, side * 0.24)
      this.sc.set(1, h, 1)
      this.upperArm.setMatrixAt(k, this.m.compose(this.p, upperQ, this.sc))
      this.upperArm.setColorAt(k, this.col.setHex(s.shirt))
      // Antebrazo: cuelga del codo, con flexión.
      const elbowOffset = new THREE.Vector3(0, -0.26 * h, 0).applyQuaternion(upperQ)
      this.p.add(elbowOffset)
      const foreQ = upperQ.multiply(new THREE.Quaternion().setFromAxisAngle(Z_AXIS, elbow))
      this.foreArm.setMatrixAt(k, this.m.compose(this.p, foreQ, this.sc))
      this.foreArm.setColorAt(k, this.col.setHex(s.sleeves ? s.shirt : s.skin))
    }

    // Cabeza, pelo y gorra.
    const headY = hipY + Math.cos(s.lean) * 0.78
    const headX = Math.sin(s.lean) * 0.78
    local(headX, headY, 0)
    this.sc.set(1, 1, 1)
    this.head.setMatrixAt(i, this.m.compose(this.p, bodyQ, this.sc))
    this.head.setColorAt(i, this.col.setHex(s.skin))
    const hairP = this.p.clone()
    if (s.cap >= 0) {
      this.cap.setMatrixAt(i, this.m.compose(hairP, bodyQ, this.sc))
      this.cap.setColorAt(i, this.col.setHex(s.cap))
      this.hairShort.setMatrixAt(i, this.hidden)
      this.hairLong.setMatrixAt(i, this.hidden)
    } else {
      this.cap.setMatrixAt(i, this.hidden)
      const target = s.hairLong ? this.hairLong : this.hairShort
      const other = s.hairLong ? this.hairShort : this.hairLong
      target.setMatrixAt(i, this.m.compose(hairP, bodyQ, this.sc))
      target.setColorAt(i, this.col.setHex(s.hair))
      other.setMatrixAt(i, this.hidden)
    }
  }

  commit() {
    for (const mesh of this.meshes) {
      mesh.instanceMatrix.needsUpdate = true
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true
    }
  }
}
