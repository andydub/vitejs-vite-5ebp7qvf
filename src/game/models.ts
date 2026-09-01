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

/**
 * Separa las cuatro ruedas de una malla única de auto ya normalizada (trompa
 * a +X, apoyada en y=0). Busca los cúmulos de vértices bajos y externos para
 * ubicar los ejes, corta los triángulos que caen dentro de cada cilindro de
 * rueda y los pasa a mallas propias con pivote en el centro de la rueda.
 */
function splitWheels(outer: THREE.Group): THREE.Group {
  outer.updateMatrixWorld(true)
  const meshes: THREE.Mesh[] = []
  outer.traverse((o) => {
    if ((o as THREE.Mesh).isMesh) meshes.push(o as THREE.Mesh)
  })
  if (meshes.length === 0) return outer
  // Geometría única en el espacio del grupo exterior.
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

  // Ejes: vértices bajos y externos, adelante (x>0) y atrás (x<0).
  const fx: number[] = []
  const fz: number[] = []
  const rx: number[] = []
  const rz: number[] = []
  for (let i = 0; i < n; i++) {
    const y = pos.getY(i)
    const z = Math.abs(pos.getZ(i))
    if (y > 0.45 || z < 0.45) continue
    const x = pos.getX(i)
    if (x > 0.3) {
      fx.push(x)
      fz.push(z)
    } else if (x < -0.3) {
      rx.push(x)
      rz.push(z)
    }
  }
  if (fx.length < 50 || rx.length < 50) return outer
  const axles = [
    { x: median(fx), z: median(fz), front: true },
    { x: median(rx), z: median(rz), front: false },
  ]
  // Radio de cada eje: la altura máxima de los vértices cerca del eje.
  const wheels = axles.flatMap((a) => {
    let top = 0
    for (let i = 0; i < n; i++) {
      if (Math.abs(pos.getX(i) - a.x) < 0.3 && Math.abs(Math.abs(pos.getZ(i)) - a.z) < 0.25) top = Math.max(top, pos.getY(i))
    }
    const radius = Math.min(0.5, Math.max(0.25, top / 2))
    return [-1, 1].map((side) => ({ ...a, side, radius, cy: radius }))
  })

  // Clasificación de triángulos.
  const tri = n / 3
  const owner = new Int8Array(tri).fill(-1)
  const counts = new Array(wheels.length + 1).fill(0)
  for (let t = 0; t < tri; t++) {
    const i = t * 3
    const cx = (pos.getX(i) + pos.getX(i + 1) + pos.getX(i + 2)) / 3
    const cy = (pos.getY(i) + pos.getY(i + 1) + pos.getY(i + 2)) / 3
    const cz = (pos.getZ(i) + pos.getZ(i + 1) + pos.getZ(i + 2)) / 3
    for (let w = 0; w < wheels.length; w++) {
      const wh = wheels[w]
      const dx = cx - wh.x
      const dy = cy - wh.cy
      const dz = cz - wh.side * wh.z
      if (Math.sign(cz) !== wh.side) continue
      if (dx * dx + dy * dy < (wh.radius * 1.08) ** 2 && Math.abs(dz) < 0.28) {
        owner[t] = w
        break
      }
    }
    counts[owner[t] + 1]++
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
  wheels.forEach((wh, w) => {
    if (counts[w + 1] < 20) return
    const center = new THREE.Vector3(wh.x, wh.cy, wh.side * wh.z)
    const mesh = new THREE.Mesh(build((t) => owner[t] === w, center), material)
    mesh.castShadow = true
    mesh.name = 'wheel_mesh'
    const pivot = new THREE.Object3D()
    pivot.name = `wheel_${wh.front ? 'f' : 'r'}_${wh.side < 0 ? 'l' : 'r'}`
    pivot.position.copy(center)
    pivot.userData.radius = wh.radius
    pivot.add(mesh)
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
