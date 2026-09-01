import * as THREE from 'three'
import { CAR_SPEC, type Car } from './car'
import { Track } from './track'

// Convención: el mundo del juego es (x, y) en planta; en Three.js va a (x, 0, y).
// Un rumbo θ (cos θ, sin θ) equivale a rotation.y = -θ con el auto mirando +X.

function makeNoiseTexture(
  size: number,
  base: [number, number, number],
  variation: number,
  streaks: boolean,
): THREE.CanvasTexture {
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d')!
  const img = ctx.createImageData(size, size)
  let seed = 1234
  const rnd = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0
    return seed / 4294967296
  }
  // Ruido por bloques suavizado para que no parezca estática de TV.
  const coarse = 8
  const grid: number[] = []
  for (let i = 0; i < (size / coarse + 1) ** 2; i++) grid.push(rnd())
  const gw = size / coarse + 1
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const gx = x / coarse
      const gy = y / coarse
      const x0 = Math.floor(gx)
      const y0 = Math.floor(gy)
      const tx = gx - x0
      const ty = gy - y0
      const a = grid[y0 * gw + x0]
      const b = grid[y0 * gw + x0 + 1]
      const c = grid[(y0 + 1) * gw + x0]
      const d = grid[(y0 + 1) * gw + x0 + 1]
      let n = (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty
      n = n * 0.7 + rnd() * 0.3
      let k = 1 + (n - 0.5) * variation
      if (streaks) {
        // Huellas longitudinales (dirección V de la textura).
        k *= 1 + 0.08 * Math.sin(x * 0.9) * Math.sin(x * 0.23)
      }
      const i = (y * size + x) * 4
      img.data[i] = Math.min(255, base[0] * k)
      img.data[i + 1] = Math.min(255, base[1] * k)
      img.data[i + 2] = Math.min(255, base[2] * k)
      img.data[i + 3] = 255
    }
  }
  ctx.putImageData(img, 0, 0)
  const tex = new THREE.CanvasTexture(canvas)
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping
  tex.colorSpace = THREE.SRGBColorSpace
  tex.anisotropy = 8
  return tex
}

function makeNumberTexture(num: number, color: string): THREE.CanvasTexture {
  const canvas = document.createElement('canvas')
  canvas.width = 256
  canvas.height = 256
  const ctx = canvas.getContext('2d')!
  ctx.fillStyle = color
  ctx.fillRect(0, 0, 256, 256)
  // Franjas estilo livery.
  ctx.globalAlpha = 0.35
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
  const tex = new THREE.CanvasTexture(canvas)
  tex.colorSpace = THREE.SRGBColorSpace
  return tex
}

const wheelGeo = new THREE.CylinderGeometry(0.3, 0.3, 0.22, 18)
wheelGeo.rotateX(Math.PI / 2)
const rearWheelGeo = new THREE.CylinderGeometry(0.42, 0.42, 0.4, 18)
rearWheelGeo.rotateX(Math.PI / 2)
const hubGeo = new THREE.CylinderGeometry(0.15, 0.15, 0.24, 12)
hubGeo.rotateX(Math.PI / 2)
const rimGeo = new THREE.CylinderGeometry(0.3, 0.3, 0.42, 16)
rimGeo.rotateX(Math.PI / 2)
const netMat = new THREE.MeshStandardMaterial({ color: 0x111111, transparent: true, opacity: 0.45, side: THREE.DoubleSide })
const rubberMat = new THREE.MeshStandardMaterial({ color: 0x1a1a1a, roughness: 0.95 })
const hubMat = new THREE.MeshStandardMaterial({ color: 0xbfbfbf, roughness: 0.4, metalness: 0.6 })
const cageMat = new THREE.MeshStandardMaterial({ color: 0x222222, roughness: 0.6, metalness: 0.4 })
const bumperMat = new THREE.MeshStandardMaterial({ color: 0xe8e8e8, roughness: 0.5, metalness: 0.3 })
const glassMat = new THREE.MeshStandardMaterial({ color: 0x334455, roughness: 0.1, metalness: 0.3 })

interface CarView {
  group: THREE.Group
  body: THREE.Group
  frontWheels: THREE.Object3D[]
  wheels: THREE.Mesh[]
  dust: THREE.Sprite[]
  dustAge: number[]
  dustNext: number
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
  const paint = new THREE.MeshStandardMaterial({ color: car.color, roughness: 0.35, metalness: 0.2 })
  const trim = new THREE.MeshStandardMaterial({ color: car.cageColor, roughness: 0.5, metalness: 0.4 })
  const numTex = makeNumberTexture(car.number, car.color)
  const decalMat = new THREE.MeshStandardMaterial({ map: numTex, roughness: 0.4, side: THREE.DoubleSide })
  const roofTex = makeNumberTexture(car.number, car.color)
  roofTex.center.set(0.5, 0.5)
  roofTex.rotation = -Math.PI / 2
  const roofMat = new THREE.MeshStandardMaterial({ map: roofTex, roughness: 0.4 })

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
  // Escapes que salen del lateral del motor.
  const header = new THREE.CylinderGeometry(0.035, 0.035, 0.7, 8)
  for (let i = 0; i < 2; i++) {
    const h = new THREE.Mesh(header, hubMat)
    h.rotation.z = Math.PI / 2
    h.position.set(L * 0.05 - i * 0.35, 0.36, -W * 0.34)
    body.add(h)
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
  // Techo con el número.
  const roof = new THREE.Mesh(new THREE.BoxGeometry(cx1 + 0.3 - cx0 + 0.1, 0.05, cz * 2 + 0.1), roofMat)
  roof.position.set((cx0 + cx1 + 0.3) / 2, yTop + 0.03, 0)
  roof.castShadow = true
  body.add(roof)
  // Parabrisas chico y red en las ventanas.
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
  // Piloto (casco).
  const helmet = new THREE.Mesh(new THREE.SphereGeometry(0.16, 12, 10), new THREE.MeshStandardMaterial({ color: 0xffffff }))
  helmet.position.set(cx0 + 0.4, yTop - 0.35, 0.12)
  body.add(helmet)
  // Laterales con número.
  for (const side of [-1, 1]) {
    const plate = new THREE.Mesh(new THREE.PlaneGeometry(0.8, 0.3), decalMat)
    plate.position.set(-L * 0.05, 0.42, side * (W * 0.3 + 0.005))
    plate.rotation.y = side > 0 ? 0 : Math.PI
    body.add(plate)
  }
  // Placa con el número atrás, apoyada en la jaula.
  const rearPlate = new THREE.Mesh(new THREE.PlaneGeometry(0.55, 0.5), decalMat)
  rearPlate.position.set(cx0 - 0.1, yTop - 0.3, cz - 0.1)
  rearPlate.rotation.y = -Math.PI / 2
  body.add(rearPlate)
  // Paragolpes trasero de caño (cuadro) y barras laterales.
  const rx = -L * 0.56
  addTube(new THREE.Vector3(rx, 0.28, -W * 0.42), new THREE.Vector3(rx, 0.28, W * 0.42), bumperMat)
  addTube(new THREE.Vector3(rx, 0.62, -W * 0.42), new THREE.Vector3(rx, 0.62, W * 0.42), bumperMat)
  addTube(new THREE.Vector3(rx, 0.28, -W * 0.42), new THREE.Vector3(rx, 0.62, -W * 0.42), bumperMat)
  addTube(new THREE.Vector3(rx, 0.28, W * 0.42), new THREE.Vector3(rx, 0.62, W * 0.42), bumperMat)
  for (const side of [-1, 1]) {
    addTube(new THREE.Vector3(-L * 0.1, 0.4, side * W * 0.5), new THREE.Vector3(L * 0.2, 0.4, side * W * 0.5), trim)
  }
  // Brazos de suspensión delantera.
  const arm = new THREE.BoxGeometry(0.05, 0.05, W * 0.55)
  for (const y of [0.24, 0.4]) {
    const a = new THREE.Mesh(arm, cageMat)
    a.position.set(L * 0.36, y, 0)
    body.add(a)
  }

  // Ruedas (fuera del cuerpo para que no se inclinen con el balanceo).
  const frontWheels: THREE.Object3D[] = []
  const wheels: THREE.Mesh[] = []
  for (const side of [-1, 1]) {
    const pivot = new THREE.Object3D()
    pivot.position.set(L * 0.36, 0.3, side * (W * 0.5))
    const wm = new THREE.Mesh(wheelGeo, rubberMat)
    wm.castShadow = true
    pivot.add(wm)
    const hub = new THREE.Mesh(hubGeo, hubMat)
    pivot.add(hub)
    group.add(pivot)
    frontWheels.push(pivot)
    wheels.push(wm)

    const rear = new THREE.Mesh(rearWheelGeo, rubberMat)
    rear.castShadow = true
    rear.position.set(-L * 0.4, 0.42, side * (W * 0.52))
    group.add(rear)
    const rim = new THREE.Mesh(rimGeo, hubMat)
    rim.position.copy(rear.position)
    group.add(rim)
    wheels.push(rear)
  }

  return { group, body, frontWheels, wheels, dust: [], dustAge: [], dustNext: 0 }
}

function makeDustTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas')
  c.width = c.height = 64
  const ctx = c.getContext('2d')!
  const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32)
  g.addColorStop(0, 'rgba(225,210,185,0.8)')
  g.addColorStop(0.5, 'rgba(215,200,175,0.35)')
  g.addColorStop(1, 'rgba(205,190,165,0)')
  ctx.fillStyle = g
  ctx.fillRect(0, 0, 64, 64)
  return new THREE.CanvasTexture(c)
}

export type CameraMode = 'chase' | 'far' | 'hood'

export class Scene3D {
  readonly renderer: THREE.WebGLRenderer
  readonly scene = new THREE.Scene()
  readonly camera: THREE.PerspectiveCamera
  private sun!: THREE.DirectionalLight
  private track: Track
  private views = new Map<number, CarView>()
  private dustMat: THREE.SpriteMaterial
  private camPos = new THREE.Vector3()
  private camTarget = new THREE.Vector3()
  private first = true
  cameraMode: CameraMode = 'chase'

  constructor(canvas: HTMLCanvasElement, track: Track, cars: Car[]) {
    this.track = track
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' })
    this.renderer.shadowMap.enabled = true
    this.renderer.shadowMap.type = THREE.PCFShadowMap
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping
    this.renderer.toneMappingExposure = 1.05
    this.renderer.outputColorSpace = THREE.SRGBColorSpace

    this.camera = new THREE.PerspectiveCamera(62, 1, 0.5, 1500)
    this.scene.fog = new THREE.Fog(0xd6e0e8, 300, 1500)

    this.dustMat = new THREE.SpriteMaterial({ map: makeDustTexture(), transparent: true, depthWrite: false, opacity: 0.8 })

    this.buildSky()
    this.buildLights()
    this.buildGround()
    this.buildTrack()
    this.buildEnvironment()
    for (const c of cars) {
      const v = buildCar(c)
      this.scene.add(v.group)
      this.views.set(c.id, v)
    }
  }

  private buildSky() {
    const geo = new THREE.SphereGeometry(1200, 24, 12)
    const mat = new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      uniforms: {
        top: { value: new THREE.Color(0x5f9ad8) },
        horizon: { value: new THREE.Color(0xd8e6ee) },
      },
      vertexShader: `varying vec3 vPos; void main(){ vPos = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
      fragmentShader: `uniform vec3 top; uniform vec3 horizon; varying vec3 vPos; void main(){ float h = normalize(vPos).y; float t = smoothstep(-0.05, 0.5, h); gl_FragColor = vec4(mix(horizon, top, t), 1.0); }`,
    })
    const sky = new THREE.Mesh(geo, mat)
    this.scene.add(sky)
  }

  private buildLights() {
    const hemi = new THREE.HemisphereLight(0xbfd8ff, 0x8a7a5a, 0.55)
    this.scene.add(hemi)
    this.sun = new THREE.DirectionalLight(0xfff2dc, 2.2)
    this.sun.position.set(-120, 180, 90)
    this.sun.castShadow = true
    this.sun.shadow.mapSize.set(2048, 2048)
    const s = 70
    this.sun.shadow.camera.left = -s
    this.sun.shadow.camera.right = s
    this.sun.shadow.camera.top = s
    this.sun.shadow.camera.bottom = -s
    this.sun.shadow.camera.near = 50
    this.sun.shadow.camera.far = 400
    this.sun.shadow.bias = -0.0008
    this.scene.add(this.sun)
    this.scene.add(this.sun.target)
  }

  private buildGround() {
    // Campo seco mendocino alrededor.
    const tex = makeNoiseTexture(256, [128, 104, 78], 0.5, false)
    tex.repeat.set(160, 160)
    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(2400, 2400),
      new THREE.MeshStandardMaterial({ map: tex, roughness: 1 }),
    )
    ground.rotation.x = -Math.PI / 2
    ground.receiveShadow = true
    this.scene.add(ground)
  }

  private buildTrack() {
    const t = this.track
    const n = t.points.length
    const half = t.width / 2
    // Cinta de tierra compactada con banquina más clara.
    const makeRibbon = (w: number, y: number, mat: THREE.Material, vRepeat: number) => {
      const pos = new Float32Array((n + 1) * 2 * 3)
      const uv = new Float32Array((n + 1) * 2 * 2)
      const idx: number[] = []
      for (let i = 0; i <= n; i++) {
        const p = t.pointAt(i)
        const nx = -Math.sin(p.heading)
        const ny = Math.cos(p.heading)
        const o = i * 6
        pos[o] = p.x + nx * w
        pos[o + 1] = y
        pos[o + 2] = p.y + ny * w
        pos[o + 3] = p.x - nx * w
        pos[o + 4] = y
        pos[o + 5] = p.y - ny * w
        uv[i * 4] = 0
        uv[i * 4 + 1] = (i / n) * vRepeat
        uv[i * 4 + 2] = 1
        uv[i * 4 + 3] = (i / n) * vRepeat
        if (i < n) {
          const a = i * 2
          idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3)
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
    const shoulderTex = makeNoiseTexture(256, [96, 74, 54], 0.5, false)
    shoulderTex.repeat.set(1, 60)
    this.scene.add(makeRibbon(half + 4, 0.01, new THREE.MeshStandardMaterial({ map: shoulderTex, roughness: 1 }), 60))
    const dirtTex = makeNoiseTexture(256, [196, 180, 150], 0.28, true)
    dirtTex.repeat.set(1, 140)
    this.scene.add(makeRibbon(half, 0.03, new THREE.MeshStandardMaterial({ map: dirtTex, roughness: 0.95 }), 140))

    // Línea de largada.
    const s0 = t.points[0]
    const line = new THREE.Mesh(new THREE.PlaneGeometry(1.2, t.width), new THREE.MeshStandardMaterial({ color: 0xf2f2f2 }))
    line.rotation.x = -Math.PI / 2
    line.rotation.z = -s0.heading
    line.position.set(s0.x, 0.05, s0.y)
    this.scene.add(line)

    // Cubiertas de protección en el exterior de las curvas.
    const tireGeo = new THREE.TorusGeometry(0.42, 0.18, 8, 14)
    tireGeo.rotateX(Math.PI / 2)
    const tirePositions: THREE.Matrix4[] = []
    for (let i = 0; i < n; i += 3) {
      const p = t.points[i]
      if (Math.abs(p.curvature) > 0.012) {
        const side = Math.sign(p.curvature) // exterior de la curva
        const nx = -Math.sin(p.heading)
        const ny = Math.cos(p.heading)
        const off = half + 5
        for (let stack = 0; stack < 2; stack++) {
          const m = new THREE.Matrix4()
          m.setPosition(p.x - nx * off * side, 0.18 + stack * 0.36, p.y - ny * off * side)
          tirePositions.push(m)
        }
      }
    }
    const tires = new THREE.InstancedMesh(tireGeo, rubberMat, tirePositions.length)
    tirePositions.forEach((m, i) => tires.setMatrixAt(i, m))
    tires.castShadow = true
    this.scene.add(tires)

    // Alambrado perimetral con postes.
    const postGeo = new THREE.CylinderGeometry(0.06, 0.06, 1.8, 6)
    const posts: THREE.Matrix4[] = []
    const fencePts: THREE.Vector3[] = []
    for (let i = 0; i < n; i += 6) {
      const p = t.points[i]
      // Lado exterior aproximado: el lado opuesto al centro del trazado.
      const cxm = (t.bounds.minX + t.bounds.maxX) / 2
      const cym = (t.bounds.minY + t.bounds.maxY) / 2
      const nx = -Math.sin(p.heading)
      const ny = Math.cos(p.heading)
      const outward = (p.x - cxm) * nx + (p.y - cym) * ny > 0 ? 1 : -1
      const off = half + 12
      const px = p.x + nx * off * outward
      const py = p.y + ny * off * outward
      const m = new THREE.Matrix4()
      m.setPosition(px, 0.9, py)
      posts.push(m)
      fencePts.push(new THREE.Vector3(px, 1.7, py))
    }
    const postMesh = new THREE.InstancedMesh(postGeo, new THREE.MeshStandardMaterial({ color: 0x6b5a42 }), posts.length)
    posts.forEach((m, i) => postMesh.setMatrixAt(i, m))
    this.scene.add(postMesh)
    fencePts.push(fencePts[0].clone())
    const wire = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints(fencePts),
      new THREE.LineBasicMaterial({ color: 0x555555 }),
    )
    this.scene.add(wire)
    const wire2 = wire.clone()
    wire2.position.y = -0.6
    this.scene.add(wire2)
  }

  private buildEnvironment() {
    const t = this.track
    const cxm = (t.bounds.minX + t.bounds.maxX) / 2
    const cym = (t.bounds.minY + t.bounds.maxY) / 2
    let seed = 99
    const rnd = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0
      return seed / 4294967296
    }
    const isNearTrack = (x: number, y: number, margin: number) => {
      const i = t.nearestIndex(x, y)
      const p = t.points[i]
      return Math.hypot(p.x - x, p.y - y) < t.width / 2 + margin
    }

    // Álamos (típicos de Mendoza): tronco + copa alargada.
    const trunkGeo = new THREE.CylinderGeometry(0.25, 0.35, 6, 6)
    const crownGeo = new THREE.ConeGeometry(1.5, 16, 7)
    const roundGeo = new THREE.IcosahedronGeometry(3.2, 1)
    const trunkMat = new THREE.MeshStandardMaterial({ color: 0x5a4632 })
    const crownMat = new THREE.MeshStandardMaterial({ color: 0x4f7a34, roughness: 0.9 })
    const trunks: THREE.Matrix4[] = []
    const crowns: THREE.Matrix4[] = []
    const rounds: THREE.Matrix4[] = []
    const w = t.bounds.maxX - t.bounds.minX
    const h = t.bounds.maxY - t.bounds.minY
    for (let k = 0; k < 260; k++) {
      const x = cxm + (rnd() - 0.5) * (w + 500)
      const y = cym + (rnd() - 0.5) * (h + 500)
      if (isNearTrack(x, y, 24)) continue
      const sc = 0.7 + rnd() * 0.6
      const m = new THREE.Matrix4().compose(new THREE.Vector3(x, 3 * sc, y), new THREE.Quaternion(), new THREE.Vector3(sc, sc, sc))
      trunks.push(m)
      if (k % 3 === 0) {
        rounds.push(new THREE.Matrix4().compose(new THREE.Vector3(x, 7 * sc, y), new THREE.Quaternion(), new THREE.Vector3(sc, sc * 0.9, sc)))
      } else {
        crowns.push(new THREE.Matrix4().compose(new THREE.Vector3(x, (6 + 8) * sc, y), new THREE.Quaternion(), new THREE.Vector3(sc, sc, sc)))
      }
    }
    const roundMesh = new THREE.InstancedMesh(roundGeo, new THREE.MeshStandardMaterial({ color: 0x5e8a3a, roughness: 0.9, flatShading: true }), rounds.length)
    rounds.forEach((m, i) => roundMesh.setMatrixAt(i, m))
    roundMesh.castShadow = true
    this.scene.add(roundMesh)
    const trunkMesh = new THREE.InstancedMesh(trunkGeo, trunkMat, trunks.length)
    const crownMesh = new THREE.InstancedMesh(crownGeo, crownMat, crowns.length)
    trunks.forEach((m, i) => trunkMesh.setMatrixAt(i, m))
    crowns.forEach((m, i) => crownMesh.setMatrixAt(i, m))
    crownMesh.castShadow = true
    this.scene.add(trunkMesh, crownMesh)

    // Autos estacionados y público detrás del alambrado, en la recta principal.
    const carGeo = new THREE.BoxGeometry(4.2, 1.5, 1.9)
    const colors = [0xffffff, 0xc0c0c0, 0x333333, 0x8b0000, 0x1c3f94, 0xd9d9d9, 0x555555]
    const start = t.points[0]
    const nx = -Math.sin(start.heading)
    const ny = Math.cos(start.heading)
    const tx = Math.cos(start.heading)
    const ty = Math.sin(start.heading)
    const outward = (start.x - cxm) * nx + (start.y - cym) * ny > 0 ? 1 : -1
    for (let k = 0; k < 26; k++) {
      const along = -60 + k * 6 + (rnd() - 0.5) * 2
      const off = t.width / 2 + 17 + rnd() * 4
      const m = new THREE.Mesh(carGeo, new THREE.MeshStandardMaterial({ color: colors[k % colors.length], roughness: 0.4, metalness: 0.3 }))
      m.position.set(start.x + tx * along + nx * off * outward, 0.75, start.y + ty * along + ny * off * outward)
      m.rotation.y = -start.heading + Math.PI / 2 + (rnd() - 0.5) * 0.3
      m.castShadow = true
      this.scene.add(m)
    }

    // Tribuna y torre de control.
    const standMat = new THREE.MeshStandardMaterial({ color: 0x8c8c8c })
    for (let step = 0; step < 6; step++) {
      const tier = new THREE.Mesh(new THREE.BoxGeometry(40, 0.6, 1.6), standMat)
      const off = t.width / 2 + 8 + step * 1.6
      tier.position.set(start.x + tx * 20 - nx * off * outward, 0.3 + step * 0.6, start.y + ty * 20 - ny * off * outward)
      tier.rotation.y = -start.heading
      tier.castShadow = true
      tier.receiveShadow = true
      this.scene.add(tier)
    }
    const tower = new THREE.Mesh(new THREE.BoxGeometry(5, 7, 4), new THREE.MeshStandardMaterial({ color: 0xf0ede4 }))
    const towerOff = t.width / 2 + 20
    tower.position.set(start.x + tx * -6 - nx * towerOff * outward, 3.5, start.y + ty * -6 - ny * towerOff * outward)
    tower.rotation.y = -start.heading
    tower.castShadow = true
    this.scene.add(tower)
    const roofT = new THREE.Mesh(new THREE.BoxGeometry(6, 0.4, 5), new THREE.MeshStandardMaterial({ color: 0x8b2e2e }))
    roofT.position.copy(tower.position).setY(7.2)
    roofT.rotation.y = tower.rotation.y
    this.scene.add(roofT)
    const win = new THREE.Mesh(new THREE.BoxGeometry(5.1, 1.4, 4.1), glassMat)
    win.position.copy(tower.position).setY(5.6)
    win.rotation.y = tower.rotation.y
    this.scene.add(win)

    // Cordillera al fondo.
    const mtnGeo = new THREE.ConeGeometry(1, 1, 5)
    const mtnMat = new THREE.MeshStandardMaterial({ color: 0x6f7f95, flatShading: true, roughness: 1 })
    const mtns = new THREE.InstancedMesh(mtnGeo, mtnMat, 40)
    const snow = new THREE.InstancedMesh(mtnGeo, new THREE.MeshStandardMaterial({ color: 0xf4f7fa, flatShading: true }), 40)
    for (let k = 0; k < 40; k++) {
      const ang = -0.9 + (k / 40) * 1.6
      const r = 1000 + rnd() * 120
      const hgt = 120 + rnd() * 160
      const wd = 220 + rnd() * 220
      const m = new THREE.Matrix4().compose(
        new THREE.Vector3(cxm + Math.cos(ang) * r, hgt / 2 - 2, cym - 300 + Math.sin(ang) * r),
        new THREE.Quaternion(),
        new THREE.Vector3(wd, hgt, wd),
      )
      mtns.setMatrixAt(k, m)
      snow.setMatrixAt(
        k,
        new THREE.Matrix4().compose(
          new THREE.Vector3(cxm + Math.cos(ang) * r, hgt - hgt * 0.14, cym - 300 + Math.sin(ang) * r),
          new THREE.Quaternion(),
          new THREE.Vector3(wd * 0.28, hgt * 0.28, wd * 0.28),
        ),
      )
    }
    this.scene.add(mtns, snow)
  }

  resize(width: number, height: number, dpr: number) {
    this.renderer.setPixelRatio(dpr)
    this.renderer.setSize(width, height, false)
    this.camera.aspect = width / height
    this.camera.updateProjectionMatrix()
  }

  update(cars: Car[], player: Car, dt: number) {
    for (const c of cars) {
      const v = this.views.get(c.id)!
      v.group.position.set(c.x, 0, c.y)
      v.group.rotation.y = -c.heading
      // Balanceo del cuerpo con el derrape y la aceleración.
      v.body.rotation.x = THREE.MathUtils.lerp(v.body.rotation.x, -c.lateralSpeed * 0.02, 0.2)
      v.body.rotation.z = THREE.MathUtils.lerp(v.body.rotation.z, c.speed * 0.002, 0.2)
      for (const fw of v.frontWheels) fw.rotation.y = -c.steerAngle
      const spin = (c.speed * dt) / 0.36
      for (const w of v.wheels) w.rotation.z -= spin
      this.updateDust(c, v, dt)
    }

    // Cámara.
    const fx = Math.cos(player.heading)
    const fz = Math.sin(player.heading)
    let desired: THREE.Vector3
    let look: THREE.Vector3
    if (this.cameraMode === 'far') {
      desired = new THREE.Vector3(player.x - fx * 16, 9, player.y - fz * 16)
      look = new THREE.Vector3(player.x + fx * 8, 0.5, player.y + fz * 8)
    } else if (this.cameraMode === 'hood') {
      desired = new THREE.Vector3(player.x + fx * 0.6, 1.25, player.y + fz * 0.6)
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
    this.camera.position.copy(this.camPos)
    this.camera.lookAt(this.camTarget)

    // El sol y su sombra siguen al jugador.
    this.sun.position.set(player.x - 120, 180, player.y + 90)
    this.sun.target.position.set(player.x, 0, player.y)
    this.sun.target.updateMatrixWorld()

    this.renderer.render(this.scene, this.camera)
  }

  private updateDust(c: Car, v: CarView, dt: number) {
    const sliding = Math.abs(c.lateralSpeed) > 1.5
    const rate = c.speed > 4 ? (sliding ? 60 : 18) * (c.onAsphalt ? 1 : 1.6) : 0
    v.dustNext -= dt
    if (rate > 0 && v.dustNext <= 0) {
      v.dustNext = 1 / rate
      let sprite: THREE.Sprite | undefined
      let idx = v.dustAge.findIndex((a) => a >= 1)
      if (idx === -1 && v.dust.length < 48) {
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
        sprite.position.set(
          c.x - fx * 1.4 - fz * side * 0.9,
          0.3,
          c.y - fz * 1.4 + fx * side * 0.9,
        )
        sprite.scale.setScalar(0.8)
      }
    }
    for (let i = 0; i < v.dust.length; i++) {
      if (v.dustAge[i] >= 1) {
        v.dust[i].visible = false
        continue
      }
      v.dustAge[i] += dt / 1.4
      const a = v.dustAge[i]
      const s = v.dust[i]
      s.visible = true
      s.position.y += dt * 0.8
      s.scale.setScalar(0.8 + a * 3.5)
      ;(s.material as THREE.SpriteMaterial).opacity = 0.55 * (1 - a)
    }
  }

  dispose() {
    this.renderer.dispose()
  }
}
