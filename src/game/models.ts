import * as THREE from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import { CAR_SPEC } from './car'

/**
 * Configuración de un modelo GLB generado a partir de una foto real.
 * `yaw` corrige la orientación para que la trompa mire a +X.
 */
export interface CarModelConfig {
  key: string // identificador para datos embebidos (window.__SPORT4_MODELS)
  url: string
  yaw: number // radianes, rotación extra alrededor de Y
  baseHue: number // tono dominante de la pintura original (grados), para reteñir
  lengthM?: number // largo real deseado (por defecto el del Sport 4)
  liftM?: number // corrección de altura por si el modelo flota o se hunde
}

const cache = new Map<string, Promise<THREE.Group>>()
const tintCache = new Map<string, THREE.Texture>()

/** Modelos embebidos como base64 (versión de un solo archivo), indexados por clave. */
declare global {
  interface Window {
    __SPORT4_MODELS?: Record<string, string>
  }
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return bytes
}

function bytesToBase64(bytes: Uint8Array): string {
  let s = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    s += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + chunk)))
  }
  return btoa(s)
}

/**
 * Reescribe un GLB para que sus imágenes vayan como data URI en vez de
 * bufferView. Así el cargador no necesita crear URLs blob, que la política de
 * seguridad de la página publicada bloquea.
 */
function glbWithDataUriImages(bytes: Uint8Array): ArrayBuffer {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (view.getUint32(0, true) !== 0x46546c67) return bytes.buffer as ArrayBuffer
  const jsonLen = view.getUint32(12, true)
  const jsonText = new TextDecoder().decode(bytes.subarray(20, 20 + jsonLen))
  const json = JSON.parse(jsonText) as {
    images?: { uri?: string; mimeType?: string; bufferView?: number }[]
    bufferViews: { buffer: number; byteOffset?: number; byteLength: number }[]
  }
  let binOffset = 20 + jsonLen
  const binLen = view.getUint32(binOffset, true)
  binOffset += 8
  const bin = bytes.subarray(binOffset, binOffset + binLen)
  for (const img of json.images ?? []) {
    if (img.bufferView === undefined) continue
    const bv = json.bufferViews[img.bufferView]
    const data = bin.subarray(bv.byteOffset ?? 0, (bv.byteOffset ?? 0) + bv.byteLength)
    img.uri = `data:${img.mimeType ?? 'image/png'};base64,${bytesToBase64(data)}`
    delete img.bufferView
  }
  let newJson = new TextEncoder().encode(JSON.stringify(json))
  const pad = (4 - (newJson.length % 4)) % 4
  if (pad) {
    const padded = new Uint8Array(newJson.length + pad)
    padded.set(newJson)
    padded.fill(0x20, newJson.length)
    newJson = padded
  }
  const total = 12 + 8 + newJson.length + 8 + binLen
  const out = new Uint8Array(total)
  const ov = new DataView(out.buffer)
  ov.setUint32(0, 0x46546c67, true)
  ov.setUint32(4, 2, true)
  ov.setUint32(8, total, true)
  ov.setUint32(12, newJson.length, true)
  ov.setUint32(16, 0x4e4f534a, true)
  out.set(newJson, 20)
  ov.setUint32(20 + newJson.length, binLen, true)
  ov.setUint32(24 + newJson.length, 0x004e4942, true)
  out.set(bin, 28 + newJson.length)
  return out.buffer
}

const loader = new GLTFLoader()
loader.setMeshoptDecoder(MeshoptDecoder)

export interface WheelPart {
  name: string
  front: boolean
  radius: number
}

/** Nombres de los pivotes de rueda dentro de un modelo ya separado. */
export const WHEEL_NAMES = ['wheel_f_l', 'wheel_f_r', 'wheel_r_l', 'wheel_r_r']

function median(values: number[]): number {
  if (!values.length) return 0
  const v = [...values].sort((a, b) => a - b)
  return v[Math.floor(v.length / 2)]
}

/** Ajuste algebraico de círculo (Kasa) a puntos 2D. Devuelve centro y radio. */
function fitCircle(pts: { x: number; y: number }[]): { cx: number; cy: number; r: number } | null {
  if (pts.length < 8) return null
  // Resolver min Σ (x²+y² + D x + E y + F)² por mínimos cuadrados (3x3).
  let sxx = 0
  let sxy = 0
  let syy = 0
  let sx = 0
  let sy = 0
  let sxz = 0
  let syz = 0
  let sz = 0
  const n = pts.length
  for (const p of pts) {
    const z = p.x * p.x + p.y * p.y
    sxx += p.x * p.x
    sxy += p.x * p.y
    syy += p.y * p.y
    sx += p.x
    sy += p.y
    sxz += p.x * z
    syz += p.y * z
    sz += z
  }
  // [sxx sxy sx; sxy syy sy; sx sy n] [D E F]' = -[sxz syz sz]'
  const m = [
    [sxx, sxy, sx],
    [sxy, syy, sy],
    [sx, sy, n],
  ]
  const b = [-sxz, -syz, -sz]
  // Eliminación gaussiana.
  for (let i = 0; i < 3; i++) {
    let piv = i
    for (let r = i + 1; r < 3; r++) if (Math.abs(m[r][i]) > Math.abs(m[piv][i])) piv = r
    ;[m[i], m[piv]] = [m[piv], m[i]]
    ;[b[i], b[piv]] = [b[piv], b[i]]
    if (Math.abs(m[i][i]) < 1e-9) return null
    for (let r = i + 1; r < 3; r++) {
      const f = m[r][i] / m[i][i]
      for (let c = i; c < 3; c++) m[r][c] -= f * m[i][c]
      b[r] -= f * b[i]
    }
  }
  const sol = [0, 0, 0]
  for (let i = 2; i >= 0; i--) {
    let acc = b[i]
    for (let c = i + 1; c < 3; c++) acc -= m[i][c] * sol[c]
    sol[i] = acc / m[i][i]
  }
  const cx = -sol[0] / 2
  const cy = -sol[1] / 2
  const r = Math.sqrt(Math.max(0, cx * cx + cy * cy - sol[2]))
  return { cx, cy, r }
}

/**
 * Separa las cuatro ruedas de una malla única de auto ya normalizada (trompa
 * a +X, apoyada en y=0). Para cada rueda ajusta un círculo a la cara externa
 * de la cubierta (los vértices más alejados del centro del auto) para obtener
 * el eje exacto y el radio, y corta solo los triángulos que caen dentro del
 * cilindro de la cubierta y la llanta. Ejes, brazos y frenos quedan en la
 * carrocería.
 */
function splitWheels(outer: THREE.Group): THREE.Group {
  outer.updateMatrixWorld(true)
  const meshes: THREE.Mesh[] = []
  outer.traverse((o) => {
    if ((o as THREE.Mesh).isMesh) meshes.push(o as THREE.Mesh)
  })
  if (meshes.length === 0) return outer
  const parts: THREE.BufferGeometry[] = []
  let material: THREE.Material | THREE.Material[] = meshes[0].material
  for (const m of meshes) {
    const g = (m.geometry.index ? m.geometry.toNonIndexed() : m.geometry.clone()) as THREE.BufferGeometry
    for (const name of Object.keys(g.attributes)) {
      if (!['position', 'normal', 'uv', 'tangent'].includes(name)) {
        g.deleteAttribute(name)
        continue
      }
      // Los atributos pueden venir cuantizados (enteros normalizados): pasarlos a flotante.
      const src = g.getAttribute(name) as THREE.BufferAttribute
      const out = new Float32Array(src.count * src.itemSize)
      for (let i = 0; i < src.count; i++) {
        for (let k = 0; k < src.itemSize; k++) out[i * src.itemSize + k] = src.getComponent(i, k)
      }
      g.setAttribute(name, new THREE.BufferAttribute(out, src.itemSize))
    }
    g.applyMatrix4(m.matrixWorld)
    parts.push(g)
    material = m.material
  }
  const geo = parts.length === 1 ? parts[0] : mergeGeometries(parts)
  const pos = geo.getAttribute('position') as THREE.BufferAttribute
  const n = pos.count

  // Ejes aproximados: vértices bajos y externos, adelante (x>0) y atrás (x<0).
  const fx: number[] = []
  const rx: number[] = []
  for (let i = 0; i < n; i++) {
    if (pos.getY(i) > 0.45 || Math.abs(pos.getZ(i)) < 0.45) continue
    const x = pos.getX(i)
    if (x > 0.3) fx.push(x)
    else if (x < -0.3) rx.push(x)
  }
  if (fx.length < 50 || rx.length < 50) return outer
  const axles = [
    { x: median(fx), front: true },
    { x: median(rx), front: false },
  ]

  interface Wheel {
    front: boolean
    side: number
    cx: number
    cy: number
    r: number
    zInner: number
    zOuter: number
  }
  const wheels: Wheel[] = []
  for (const a of axles) {
    for (const side of [-1, 1]) {
      // Región de búsqueda alrededor del eje aproximado, de un lado del auto.
      const idx: number[] = []
      let zOuter = 0
      for (let i = 0; i < n; i++) {
        const z = pos.getZ(i)
        if (Math.sign(z) !== side || Math.abs(z) < 0.3) continue
        if (Math.abs(pos.getX(i) - a.x) > 0.6 || pos.getY(i) > 1.0) continue
        idx.push(i)
        zOuter = Math.max(zOuter, Math.abs(z))
      }
      if (idx.length < 40) continue
      // Cara externa de la cubierta: banda de vértices más alejados del centro.
      const band = idx.filter((i) => Math.abs(pos.getZ(i)) >= zOuter - 0.07).map((i) => ({ x: pos.getX(i), y: pos.getY(i) }))
      let fit = fitCircle(band)
      if (!fit || !isFinite(fit.r) || fit.r < 0.15 || fit.r > 0.6 || Math.abs(fit.cx - a.x) > 0.4) {
        // Alternativa: caja de la banda.
        let minX = Infinity
        let maxX = -Infinity
        let maxY = 0
        for (const p of band) {
          minX = Math.min(minX, p.x)
          maxX = Math.max(maxX, p.x)
          maxY = Math.max(maxY, p.y)
        }
        fit = { cx: (minX + maxX) / 2, cy: maxY / 2, r: maxY / 2 }
      }
      // Radio robusto: percentil 92 de las distancias al centro en la banda.
      const dists = band.map((p) => Math.hypot(p.x - fit!.cx, p.y - fit!.cy)).sort((u, v) => u - v)
      const r = dists[Math.floor(dists.length * 0.92)] || fit.r
      // Ancho de la cubierta: la cara interna es el |z| mínimo de los vértices
      // que están a distancia radial de cubierta (no del eje ni de los brazos).
      let zInner = zOuter
      for (const i of idx) {
        const d = Math.hypot(pos.getX(i) - fit.cx, pos.getY(i) - fit.cy)
        if (d > r * 0.72 && d < r * 1.02) zInner = Math.min(zInner, Math.abs(pos.getZ(i)))
      }
      zInner = Math.max(zOuter - 0.5, Math.min(zOuter - 0.12, zInner))
      wheels.push({ front: a.front, side, cx: fit.cx, cy: fit.cy, r, zInner, zOuter })
    }
  }
  if (wheels.length < 4) return outer

  // Clasificación de triángulos: los tres vértices dentro del cilindro de la rueda.
  const tri = n / 3
  const owner = new Int8Array(tri).fill(-1)
  const counts = new Array(wheels.length).fill(0)
  const inside = (i: number, w: Wheel) => {
    const z = pos.getZ(i)
    if (Math.sign(z) !== w.side) return false
    const az = Math.abs(z)
    if (az < w.zInner - 0.015 || az > w.zOuter + 0.05) return false
    const d = Math.hypot(pos.getX(i) - w.cx, pos.getY(i) - w.cy)
    if (d > w.r * 1.04) return false
    // Cerca del eje solo cuenta la cara externa de la llanta; lo que está
    // hacia adentro (maza, brazos, frenos) queda en la carrocería.
    // En la mitad interna del ancho solo cuenta la banda de la cubierta.
    if (d < w.r * 0.72 && az < w.zOuter - (w.zOuter - w.zInner) * 0.45) return false
    return true
  }
  for (let t = 0; t < tri; t++) {
    const i = t * 3
    for (let w = 0; w < wheels.length; w++) {
      if (inside(i, wheels[w]) && inside(i + 1, wheels[w]) && inside(i + 2, wheels[w])) {
        owner[t] = w
        counts[w]++
        break
      }
    }
  }

  const build = (filter: (t: number) => boolean, offset: THREE.Vector3): THREE.BufferGeometry => {
    const g = new THREE.BufferGeometry()
    for (const name of Object.keys(geo.attributes)) {
      const src = geo.getAttribute(name) as THREE.BufferAttribute
      const size = src.itemSize
      const out: number[] = []
      for (let t = 0; t < tri; t++) {
        if (!filter(t)) continue
        for (let v = 0; v < 3; v++) {
          const i = t * 3 + v
          for (let k = 0; k < size; k++) {
            let val = src.array[i * size + k] as number
            if (name === 'position') val -= k === 0 ? offset.x : k === 1 ? offset.y : k === 2 ? offset.z : 0
            out.push(val)
          }
        }
      }
      g.setAttribute(name, new THREE.Float32BufferAttribute(out, size))
    }
    return g
  }

  const result = new THREE.Group()
  const body = new THREE.Mesh(build((t) => owner[t] === -1, new THREE.Vector3()), material)
  body.castShadow = true
  body.name = 'body'
  result.add(body)
  // La geometría de las ruedas generadas se descarta: en su lugar cada pivote
  // recibe una rueda hecha por código (ver wheel.ts) con el radio y ancho medidos.
  wheels.forEach((wh, w) => {
    if (counts[w] < 20) return
    const zc = wh.side * ((wh.zInner + wh.zOuter) / 2)
    const pivot = new THREE.Object3D()
    pivot.name = `wheel_${wh.front ? 'f' : 'r'}_${wh.side < 0 ? 'l' : 'r'}`
    pivot.position.set(wh.cx, wh.cy, zc)
    pivot.userData.radius = wh.r
    pivot.userData.width = Math.max(0.16, wh.zOuter - wh.zInner)
    pivot.userData.side = wh.side
    pivot.userData.baseY = wh.cy
    result.add(pivot)
  })
  return result
}

/**
 * Carga un GLB y lo normaliza: centrado en X/Z, apoyado en y=0, escalado al
 * largo real del auto y girado para que la trompa apunte a +X.
 */
export function loadCarModel(cfg: CarModelConfig): Promise<THREE.Group> {
  const key = `${cfg.key}|${cfg.yaw}`
  let p = cache.get(key)
  if (!p) {
    p = new Promise<THREE.Group>((resolve, reject) => {
      const onError = (err: unknown) => reject(err instanceof Error ? err : new Error(String(err)))
      const embedded = window.__SPORT4_MODELS?.[cfg.key]
      const onLoad = (gltf: { scene: THREE.Group }) => {
        const root = gltf.scene
        root.traverse((o) => {
          if ((o as THREE.Mesh).isMesh) {
            const m = o as THREE.Mesh
            m.castShadow = true
            m.receiveShadow = false
            const mat = m.material as THREE.MeshStandardMaterial
            if (mat && 'roughness' in mat) mat.roughness = Math.min(mat.roughness, 0.7)
          }
        })
        // Primero la rotación, después medir.
        const wrapper = new THREE.Group()
        root.rotation.y = cfg.yaw
        wrapper.add(root)
        const box = new THREE.Box3().setFromObject(wrapper)
        const size = new THREE.Vector3()
        box.getSize(size)
        const length = Math.max(size.x, 1e-3)
        const scale = (cfg.lengthM ?? CAR_SPEC.lengthM) / length
        wrapper.scale.setScalar(scale)
        const box2 = new THREE.Box3().setFromObject(wrapper)
        const center = new THREE.Vector3()
        box2.getCenter(center)
        wrapper.position.set(-center.x, -box2.min.y + (cfg.liftM ?? 0), -center.z)
        const outer = new THREE.Group()
        outer.add(wrapper)
        resolve(splitWheels(outer))
      }
      if (embedded) {
        // Imágenes como data URI y carga por <img> (sin fetch ni blob), que
        // es lo único que permite la página publicada.
        const buffer = glbWithDataUriImages(base64ToBytes(embedded))
        const w = window as unknown as { createImageBitmap?: unknown }
        const saved = w.createImageBitmap
        w.createImageBitmap = undefined
        try {
          loader.parse(buffer, '', onLoad, onError)
        } finally {
          w.createImageBitmap = saved
        }
      } else {
        loader.load(cfg.url, onLoad, undefined, onError)
      }
    })
    cache.set(key, p)
  }
  // Cada auto recibe su propia copia.
  return p.then((g) => g.clone(true))
}

/** Tono (0-360) de un color hexadecimal. */
export function hueOf(hex: string): number {
  const c = new THREE.Color(hex)
  const hsl = { h: 0, s: 0, l: 0 }
  c.getHSL(hsl)
  return hsl.h * 360
}

/**
 * Cambia el tono de la pintura de un modelo (rotación de matiz sobre la
 * textura base) para reutilizar el mismo modelo con distintas liveries.
 */
export function applyHueShift(model: THREE.Object3D, modelKey: string, degrees: number) {
  const deg = ((degrees % 360) + 360) % 360
  if (deg < 2 || deg > 358) return
  model.traverse((o) => {
    const mesh = o as THREE.Mesh
    if (!mesh.isMesh) return
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
    const cloned = mats.map((m) => {
      const mat = (m as THREE.MeshStandardMaterial).clone()
      const map = mat.map
      const image = map?.image as (HTMLImageElement | ImageBitmap | HTMLCanvasElement) | undefined
      if (map && image && image.width > 0) {
        const cacheKey = `${modelKey}|${map.uuid}|${Math.round(deg)}`
        let tinted = tintCache.get(cacheKey)
        if (!tinted) {
          const canvas = document.createElement('canvas')
          canvas.width = image.width
          canvas.height = image.height
          const ctx = canvas.getContext('2d')!
          ctx.filter = `hue-rotate(${deg}deg)`
          ctx.drawImage(image, 0, 0)
          const t = new THREE.CanvasTexture(canvas)
          t.flipY = map.flipY
          t.colorSpace = map.colorSpace
          t.wrapS = map.wrapS
          t.wrapT = map.wrapT
          t.channel = map.channel
          t.needsUpdate = true
          tintCache.set(cacheKey, t)
          tinted = t
        }
        mat.map = tinted
      }
      return mat
    })
    mesh.material = Array.isArray(mesh.material) ? cloned : cloned[0]
  })
}

const base = import.meta.env.BASE_URL
export const CAR_MODELS: Record<string, CarModelConfig | undefined> = {
  car29: { key: 'car29', url: `${base}models/car29.glb`, yaw: Math.PI, baseHue: 218 },
  car1: { key: 'car1', url: `${base}models/car1.glb`, yaw: Math.PI, baseHue: 215 },
}
