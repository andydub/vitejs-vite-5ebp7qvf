import * as THREE from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js'
import { CAR_SPEC } from './car'

/**
 * Configuración de un modelo GLB generado a partir de una foto real.
 * `yaw` corrige la orientación para que la trompa mire a +X.
 */
export interface CarModelConfig {
  key: string // identificador para datos embebidos (window.__SPORT4_MODELS)
  url: string
  yaw: number // radianes, rotación extra alrededor de Y
  lengthM?: number // largo real deseado (por defecto el del Sport 4)
  liftM?: number // corrección de altura por si el modelo flota o se hunde
}

const cache = new Map<string, Promise<THREE.Group>>()

/** Modelos embebidos como base64 (versión de un solo archivo), indexados por clave. */
declare global {
  interface Window {
    __SPORT4_MODELS?: Record<string, string>
  }
}

function base64ToBuffer(b64: string): ArrayBuffer {
  const bin = atob(b64)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return bytes.buffer
}
const loader = new GLTFLoader()
loader.setMeshoptDecoder(MeshoptDecoder)

/**
 * Carga un GLB y lo normaliza: centrado en X/Z, apoyado en y=0, escalado al
 * largo real del auto y girado para que la trompa apunte a +X.
 */
export function loadCarModel(cfg: CarModelConfig): Promise<THREE.Group> {
  const key = `${cfg.url}|${cfg.yaw}`
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
        resolve(outer)
      }
      if (embedded) loader.parse(base64ToBuffer(embedded), '', onLoad, onError)
      else loader.load(cfg.url, onLoad, undefined, onError)
    })
    cache.set(key, p)
  }
  // Cada auto recibe su propia copia.
  return p.then((g) => g.clone(true))
}

const base = import.meta.env.BASE_URL
export const CAR_MODELS: Record<string, CarModelConfig | undefined> = {
  car29: { key: 'car29', url: `${base}models/car29.glb`, yaw: Math.PI },
  car1: { key: 'car1', url: `${base}models/car1.glb`, yaw: Math.PI },
}
