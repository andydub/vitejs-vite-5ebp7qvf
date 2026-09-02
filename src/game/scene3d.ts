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
import { applyHueShift, loadCarModel, WHEEL_NAMES } from './models'
import { buildWheel } from './wheel'

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

/** Cartel de sponsor o pancarta: fondo de color y texto grande. */
function makeBannerTexture(text: string, bg: string, fg: string, w = 1024, h = 192): THREE.CanvasTexture {
  const c = document.createElement('canvas')
  c.width = w
  c.height = h
  const ctx = c.getContext('2d')!
  ctx.fillStyle = bg
  ctx.fillRect(0, 0, w, h)
  ctx.strokeStyle = fg
  ctx.lineWidth = 10
  ctx.strokeRect(14, 14, w - 28, h - 28)
  ctx.fillStyle = fg
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  let size = h * 0.55
  ctx.font = `bold ${size}px sans-serif`
  while (ctx.measureText(text).width > w * 0.85 && size > 20) {
    size -= 4
    ctx.font = `bold ${size}px sans-serif`
  }
  ctx.fillText(text, w / 2, h / 2 + 4)
  return canvasTexture(c, false)
}

/** Texto en arco (para el óvalo de ACT). */
function arcText(ctx: CanvasRenderingContext2D, text: string, cx: number, cy: number, r: number, centerAngle: number, spread: number, inward: boolean) {
  const chars = text.split('')
  const step = spread / Math.max(1, chars.length - 1)
  chars.forEach((ch, i) => {
    // En el arco inferior las letras avanzan en sentido contrario para leerse de izquierda a derecha.
    const a = inward ? centerAngle + spread / 2 - step * i : centerAngle - spread / 2 + step * i
    ctx.save()
    ctx.translate(cx + Math.cos(a) * r, cy + Math.sin(a) * r)
    ctx.rotate(a + (inward ? -Math.PI / 2 : Math.PI / 2))
    ctx.fillText(ch, 0, 0)
    ctx.restore()
  })
}

/** Logo de ACT: óvalo azul con borde gris, bandera argentina y damero dentro de un anillo rojo, "ACT" en rojo. */
function drawACTLogo(ctx: CanvasRenderingContext2D, cx: number, cy: number, w: number) {
  const h = w * 0.66
  ctx.save()
  ctx.translate(cx, cy)
  // Óvalo azul con borde gris.
  ctx.fillStyle = '#1730b8'
  ctx.strokeStyle = '#a9a9a9'
  ctx.lineWidth = w * 0.03
  ctx.beginPath()
  ctx.ellipse(0, 0, w / 2, h / 2, 0, 0, Math.PI * 2)
  ctx.fill()
  ctx.stroke()
  // Interior: mitad bandera, mitad damero, recortado por el óvalo interno.
  const iw = w * 0.56
  const ih = h * 0.52
  ctx.save()
  ctx.beginPath()
  ctx.ellipse(0, 0, iw / 2, ih / 2, 0, 0, Math.PI * 2)
  ctx.clip()
  const bands = ['#5bc4f0', '#ffffff', '#5bc4f0']
  bands.forEach((c, i) => {
    ctx.fillStyle = c
    ctx.fillRect(-iw / 2, -ih / 2 + (ih / 3) * i, iw / 2, ih / 3 + 1)
  })
  const sq = iw / 12
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 6; x++) {
      ctx.fillStyle = (x + y) % 2 ? '#111' : '#fff'
      ctx.fillRect(x * sq, -ih / 2 + y * sq, sq, sq)
    }
  }
  ctx.restore()
  // Anillo rojo.
  ctx.strokeStyle = '#e60000'
  ctx.lineWidth = w * 0.045
  ctx.beginPath()
  ctx.ellipse(0, 0, iw / 2, ih / 2, 0, 0, Math.PI * 2)
  ctx.stroke()
  // ACT.
  ctx.fillStyle = '#e60000'
  ctx.strokeStyle = '#ffffff'
  ctx.lineWidth = w * 0.02
  ctx.font = `900 ${Math.round(w * 0.2)}px sans-serif`
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.strokeText('ACT', 0, w * 0.01)
  ctx.fillText('ACT', 0, w * 0.01)
  // Textos en arco.
  ctx.fillStyle = '#ffffff'
  ctx.font = `bold ${Math.round(w * 0.048)}px sans-serif`
  arcText(ctx, 'ASOCIACION DE CATEGORIAS', 0, 0, h * 0.41, -Math.PI / 2, 2.3, false)
  arcText(ctx, 'TRADICIONALES', 0, 0, h * 0.41, Math.PI / 2, 1.35, true)
  ctx.restore()
}

/** Banner de la Asociación de Categorías Tradicionales (ACT): damero, logo y franja roja. */
function makeACTBanner(): THREE.CanvasTexture {
  const w = 1024
  const h = 1024
  const c = document.createElement('canvas')
  c.width = w
  c.height = h
  const ctx = c.getContext('2d')!
  ctx.fillStyle = '#f4f4f4'
  ctx.fillRect(0, 0, w, h)
  // Damero en toda la parte superior, como en la lona real.
  const sq = 96
  for (let y = 0; y < 6; y++) {
    for (let x = 0; x < w / sq + 1; x++) {
      ctx.fillStyle = (x + y) % 2 ? '#1a1a1a' : '#f4f4f4'
      ctx.fillRect(x * sq, y * sq, sq, sq)
    }
  }
  // Foto azulada de autos (bandas simulando la foto) y franja roja degradada abajo.
  const photo = ctx.createLinearGradient(0, h * 0.56, 0, h * 0.74)
  photo.addColorStop(0, '#6f8fbf')
  photo.addColorStop(1, '#3d5a8a')
  ctx.fillStyle = photo
  ctx.fillRect(0, h * 0.56, w, h * 0.18)
  ctx.fillStyle = '#c9b48a'
  ctx.fillRect(0, h * 0.68, w, h * 0.06)
  const g = ctx.createLinearGradient(0, h * 0.74, 0, h)
  g.addColorStop(0, '#f4f4f4')
  g.addColorStop(1, '#d42020')
  ctx.fillStyle = g
  ctx.fillRect(0, h * 0.74, w, h * 0.26)
  drawACTLogo(ctx, w / 2, h * 0.36, 520)
  ctx.fillStyle = '#333'
  ctx.font = 'bold 30px sans-serif'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText('DESDE 1982', w / 2, h * 0.6)
  const tex = canvasTexture(c, false)
  // Logo real de ACT (public/img/logo-act.png) si está disponible.
  loadOptionalImage('logo-act.png', (img) => {
    const lw = 560
    const lh = (lw * img.height) / img.width
    ctx.drawImage(img, w / 2 - lw / 2, h * 0.36 - lh / 2, lw, lh)
    tex.needsUpdate = true
  })
  return tex
}

/**
 * Isologo de General Alvear: nudo de cintas naranja, verde y azul, y texto.
 * `size` es el ancho del nudo; con `stacked` el texto va centrado debajo.
 */
function drawGALogo(ctx: CanvasRenderingContext2D, cx: number, cy: number, size: number, stacked = false) {
  const u = size / 400 // el nudo ocupa ≈400 unidades de ancho en el dibujo original
  ctx.save()
  ctx.translate(cx - 200 * u, cy - 240 * u)
  ctx.scale(u, u)
  ctx.lineCap = 'round'
  ctx.lineWidth = 62
  // Cinta verde: baja por la izquierda y gira hacia abajo a la derecha.
  let g = ctx.createLinearGradient(60, 200, 300, 460)
  g.addColorStop(0, '#2fb5a0')
  g.addColorStop(1, '#0f6d68')
  ctx.strokeStyle = g
  ctx.beginPath()
  ctx.moveTo(150, 205)
  ctx.bezierCurveTo(40, 260, 60, 380, 160, 420)
  ctx.bezierCurveTo(200, 436, 240, 436, 262, 440)
  ctx.stroke()
  // Cinta naranja: sube desde el centro, pasa por arriba y cae a la derecha en rojo.
  g = ctx.createLinearGradient(120, 60, 300, 460)
  g.addColorStop(0, '#f4b21e')
  g.addColorStop(0.5, '#f18a1c')
  g.addColorStop(1, '#d73b2a')
  ctx.strokeStyle = g
  ctx.beginPath()
  ctx.moveTo(110, 120)
  ctx.bezierCurveTo(140, 40, 260, 60, 262, 170)
  ctx.bezierCurveTo(264, 260, 250, 380, 262, 440)
  ctx.stroke()
  // Cinta azul: swoosh de izquierda a derecha por el medio.
  g = ctx.createLinearGradient(100, 250, 380, 190)
  g.addColorStop(0, '#0d3a63')
  g.addColorStop(1, '#3b8fbd')
  ctx.strokeStyle = g
  ctx.beginPath()
  ctx.moveTo(150, 205)
  ctx.bezierCurveTo(200, 245, 280, 250, 360, 185)
  ctx.stroke()
  // Texto: a la derecha (logo horizontal) o debajo (panel vertical).
  ctx.textBaseline = 'alphabetic'
  ctx.fillStyle = '#1f3a6b'
  if (stacked) {
    ctx.textAlign = 'center'
    ctx.font = "500 96px 'Barlow', sans-serif"
    ctx.fillText('General', 200, 580)
    ctx.font = "900 150px 'Barlow Condensed', 'Arial Narrow', sans-serif"
    ctx.fillText('ALVEAR', 200, 720)
    ctx.fillStyle = '#2bb3a0'
    ctx.font = "600 40px 'Barlow', sans-serif"
    ctx.fillText('Tierra de Oportunidades', 200, 780)
  } else {
    ctx.textAlign = 'left'
    ctx.font = "500 118px 'Barlow', sans-serif"
    ctx.fillText('General', 420, 240)
    ctx.font = "900 176px 'Barlow Condensed', 'Arial Narrow', sans-serif"
    ctx.fillText('ALVEAR', 400, 395)
    ctx.fillStyle = '#2bb3a0'
    ctx.font = "600 44px 'Barlow', sans-serif"
    ctx.fillText('Tierra de Oportunidades', 420, 465)
  }
  ctx.restore()
}

/** Panel de la Municipalidad de General Alvear: fondo blanco con formas de colores y el isologo. */
function makeGABanner(): THREE.CanvasTexture {
  const w = 512
  const h = 1024
  const c = document.createElement('canvas')
  c.width = w
  c.height = h
  const ctx = c.getContext('2d')!
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, w, h)
  // Arcos y figuras decorativas del panel real.
  const arcs: [number, number, number, string][] = [
    [110, 150, 100, '#2bb3a0'],
    [420, 260, 80, '#f5a623'],
    [90, 800, 110, '#8e3a9c'],
    [430, 900, 90, '#e94e3d'],
  ]
  ctx.lineWidth = 30
  ctx.lineCap = 'round'
  for (const [x, y, r, col] of arcs) {
    ctx.strokeStyle = col
    ctx.beginPath()
    ctx.arc(x, y, r, Math.PI * 0.2, Math.PI * 1.3)
    ctx.stroke()
  }
  ctx.fillStyle = '#2bb3a0'
  ctx.beginPath()
  ctx.moveTo(380, 80)
  ctx.lineTo(404, 120)
  ctx.lineTo(356, 120)
  ctx.closePath()
  ctx.fill()
  ctx.fillStyle = '#8e3a9c'
  ctx.save()
  ctx.translate(420, 700)
  ctx.rotate(Math.PI / 4)
  ctx.fillRect(-14, -14, 28, 28)
  ctx.restore()
  // Isologo grande, centrado.
  drawGALogo(ctx, w / 2, h * 0.36, 300, true)
  ctx.fillStyle = '#333'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.font = "500 24px 'Barlow', sans-serif"
  ctx.fillText('Dirección de', w / 2, h * 0.8)
  ctx.font = "700 26px 'Barlow', sans-serif"
  ctx.fillText('Deportes, Actividad', w / 2, h * 0.835)
  ctx.fillText('Física y Recreación', w / 2, h * 0.87)
  const tex = canvasTexture(c, false)
  // Logo real de la Municipalidad (public/img/logo-alvear.png) si está disponible.
  loadOptionalImage('logo-alvear.png', (img) => {
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(30, h * 0.2, w - 60, h * 0.42)
    const lw = w - 80
    const lh = (lw * img.height) / img.width
    ctx.drawImage(img, 40, h * 0.41 - lh / 2, lw, lh)
    tex.needsUpdate = true
  })
  return tex
}

/** Imágenes reales opcionales (logos, fotos): embebidas en la página de un solo archivo o servidas desde /img. */
declare global {
  interface Window {
    __SPORT4_IMG?: Record<string, string>
  }
}
export function imageSrc(key: string): string {
  return window.__SPORT4_IMG?.[key] ?? `${import.meta.env.BASE_URL}img/${key}`
}
/** Carga una imagen si existe; si falta, no hace nada (queda la versión dibujada). */
function loadOptionalImage(key: string, onLoad: (img: HTMLImageElement) => void) {
  const img = new Image()
  img.onload = () => onLoad(img)
  img.onerror = () => undefined
  img.src = imageSrc(key)
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
let contactShadowTex: THREE.CanvasTexture | null = null
let grilleTex: THREE.CanvasTexture | null = null

interface CarView {
  group: THREE.Group
  body: THREE.Group
  frontWheels: THREE.Object3D[]
  wheels: THREE.Object3D[]
  dust: THREE.Sprite[]
  dustAge: number[]
  dustNext: number
  markDist: number
  markIndex: number
  modelWheels: { pivot: THREE.Object3D; mesh: THREE.Object3D; front: boolean; radius: number }[]
  // Suspensión: nodos que se mueven y estado del resorte de la carrocería.
  bodyNode: THREE.Object3D
  wheelNodes: { node: THREE.Object3D; baseY: number; x: number; z: number }[]
  susp: { heave: number; heaveV: number; pitch: number; pitchV: number; roll: number; rollV: number; prevSpeed: number; prevHeading: number }
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
  const wheels: THREE.Object3D[] = []
  for (const side of [-1, 1]) {
    const pivot = new THREE.Object3D()
    pivot.position.set(L * 0.36, 0.3, side * (W * 0.5))
    const wm = buildWheel(0.3, 0.18, side)
    pivot.add(wm)
    group.add(pivot)
    frontWheels.push(pivot)
    wheels.push(wm)

    const rearPivot = new THREE.Object3D()
    rearPivot.position.set(-L * 0.4, 0.42, side * (W * 0.52))
    const rear = buildWheel(0.42, 0.3, side)
    rearPivot.add(rear)
    group.add(rearPivot)
    wheels.push(rear)
  }

  const wheelNodes = [
    { node: frontWheels[0], baseY: 0.3, x: L * 0.36, z: -W * 0.5 },
    { node: frontWheels[1], baseY: 0.3, x: L * 0.36, z: W * 0.5 },
    { node: wheels[1].parent!, baseY: 0.42, x: -L * 0.4, z: -W * 0.52 },
    { node: wheels[3].parent!, baseY: 0.42, x: -L * 0.4, z: W * 0.52 },
  ]
  return {
    group,
    body,
    frontWheels,
    wheels,
    dust: [],
    dustAge: [],
    dustNext: 0,
    markDist: 0,
    markIndex: 0,
    modelWheels: [],
    bodyNode: body,
    wheelNodes,
    susp: { heave: 0, heaveV: 0, pitch: 0, pitchV: 0, roll: 0, rollV: 0, prevSpeed: 0, prevHeading: 0 },
  }
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
  private grade!: ShaderPass
  private smoke: THREE.Sprite[] = []
  private flags: THREE.Mesh[] = []
  private walkers: { index: number; x: number; z: number; y0: number; h: number; shirt: number; pants: number; cap: number; dx: number; dz: number; amp: number; speed: number; phase: number }[] = []
  private crowd: CrowdPeople | null = null
  private time = 0
  cameraMode: CameraMode = 'chase'

  constructor(canvas: HTMLCanvasElement, track: Track, cars: Car[]) {
    this.track = track
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' })
    this.renderer.shadowMap.enabled = true
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping
    this.renderer.toneMappingExposure = 1.0
    this.renderer.outputColorSpace = THREE.SRGBColorSpace

    this.camera = new THREE.PerspectiveCamera(62, 1, 0.5, 4000)
    this.scene.fog = new THREE.Fog(0xe6d6bf, 220, 2000)

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
        view.modelWheels = []
        const wheelNodes: CarView['wheelNodes'] = []
        for (const name of WHEEL_NAMES) {
          const pivot = model.getObjectByName(name)
          if (pivot) {
            const radius = (pivot.userData.radius as number) || 0.34
            const front = name.includes('_f_')
            // Proporción real (185/60 R14): ancho ≈ 0,3 del diámetro adelante, algo más atrás.
            const width = Math.min((pivot.userData.width as number) || 0.24, radius * (front ? 0.6 : 0.72))
            const side = (pivot.userData.side as number) || Math.sign(pivot.position.z) || 1
            const wheel = buildWheel(radius, width, side)
            pivot.add(wheel)
            view.modelWheels.push({ pivot, mesh: wheel, front: name.includes('_f_'), radius })
            wheelNodes.push({ node: pivot, baseY: pivot.position.y, x: pivot.position.x, z: pivot.position.z })
          }
        }
        const bodyNode = model.getObjectByName('body')
        if (bodyNode && wheelNodes.length === 4) {
          view.bodyNode = bodyNode
          view.wheelNodes = wheelNodes
        }
      })
      .catch((err: unknown) => {
        console.warn('No se pudo cargar el modelo del auto', cfg.url, err)
      })
  }

  /** Bloom suave, viñeta con leve calidez y antialiasing SMAA. */
  private buildPostProcessing() {
    this.composer = new EffectComposer(this.renderer)
    this.composer.addPass(new RenderPass(this.scene, this.camera))
    this.bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.3, 0.7, 0.8)
    this.composer.addPass(this.bloom)
    // Gradación cinematográfica: sombras frías, luces cálidas, contraste
    // suave, viñeta y un grano de película muy leve.
    this.grade = new ShaderPass({
      uniforms: { tDiffuse: { value: null }, strength: { value: 0.6 }, time: { value: 0 } },
      vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
      fragmentShader: `uniform sampler2D tDiffuse; uniform float strength; uniform float time; varying vec2 vUv;
        float hash(vec2 p){ return fract(sin(dot(p, vec2(12.9898, 78.233)) + time) * 43758.5453); }
        void main(){
          vec4 c = texture2D(tDiffuse, vUv);
          vec3 col = c.rgb;
          float l = dot(col, vec3(0.299, 0.587, 0.114));
          // Separación tonal: sombras hacia azul, luces hacia ámbar.
          float t = smoothstep(0.05, 0.9, l);
          vec3 shadowTint = vec3(0.90, 0.96, 1.10);
          vec3 highTint = vec3(1.08, 1.00, 0.90);
          col *= mix(shadowTint, highTint, t);
          // Contraste suave y saturación.
          col = (col - 0.18) * 1.08 + 0.18;
          l = dot(col, vec3(0.299, 0.587, 0.114));
          col = mix(vec3(l), col, 1.18);
          // Viñeta.
          vec2 d = vUv - 0.5; float v = 1.0 - smoothstep(0.3, 0.95, length(d) * 1.4) * strength;
          col *= v;
          // Grano.
          col += (hash(vUv * 1000.0) - 0.5) * 0.02;
          gl_FragColor = vec4(max(col, 0.0), c.a);
        }`,
    })
    this.composer.addPass(this.grade)
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
        top: { value: new THREE.Color(0x3f78b8) },
        mid: { value: new THREE.Color(0x9fbfe0) },
        horizon: { value: new THREE.Color(0xf3dcc0) },
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
    this.scene.environmentIntensity = 0.3
    pmrem.dispose()
  }

  private buildLights() {
    const hemi = new THREE.HemisphereLight(0x9fb8e0, 0x6a4a30, 0.55)
    this.scene.add(hemi)
    this.sun = new THREE.DirectionalLight(0xffd9a0, 2.3)
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
    const bannerMat = new THREE.MeshStandardMaterial({ map: makeBannerTexture('LARGADA · AUTÓDROMO VÍCTOR GARCÍA', '#ffffff', '#1d3f8f', 2048, 256), side: THREE.DoubleSide, roughness: 0.8 })
    const banner = new THREE.Mesh(new THREE.PlaneGeometry(t.width + 3, 1.3), bannerMat)
    banner.position.set(s0.x, 4.9, s0.y)
    banner.rotation.y = -s0.heading - Math.PI / 2
    this.scene.add(banner)

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
      const tires = new THREE.InstancedMesh(tireGeo, new THREE.MeshStandardMaterial({ roughness: 0.9 }), tirePositions.length)
      const tireColors = [0xf2f2f2, 0x1d5bd8, 0xf2f2f2, 0xd42020]
      tirePositions.forEach((m, i) => {
        tires.setMatrixAt(i, m)
        tires.setColorAt(i, new THREE.Color(tireColors[Math.floor(i / 2) % tireColors.length]))
      })
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

    // Alambrado al pie del terraplén: postes e hilos, más carteles de sponsors
    // mirando a la pista.
    const fencePostGeo = new THREE.CylinderGeometry(0.05, 0.05, 1.6, 6)
    const fencePosts: THREE.Matrix4[] = []
    const wirePts: THREE.Vector3[] = []
    const sponsorMats = ['YPF', 'AUTOMOTORES ALVAREZ', 'LUBRICENTRO', 'NEUMÁTICOS', 'TALLER SCHIAVONE', 'CARROCERÍAS', 'AGRO ALVEAR', 'MG'].map(
      (txt, i) =>
        new THREE.MeshStandardMaterial({
          map: makeBannerTexture(txt, ['#1d3f8f', '#ffffff', '#d42020', '#ffd500', '#0f7a3a', '#ffffff', '#1d3f8f', '#111111'][i], ['#ffffff', '#1d3f8f', '#ffffff', '#111111', '#ffffff', '#d42020', '#ffd500', '#ffffff'][i]),
          side: THREE.DoubleSide,
          roughness: 0.85,
        }),
    )
    const bannerGeo = new THREE.PlaneGeometry(6, 1.1)
    let bannerIdx = 0
    for (let i = 0; i < n; i += 4) {
      const p = t.points[i]
      const nx = -Math.sin(p.heading)
      const ny = Math.cos(p.heading)
      const outward = outwardAt(p)
      const off = half + 9.5
      const px = p.x + nx * off * outward
      const py = p.y + ny * off * outward
      fencePosts.push(new THREE.Matrix4().setPosition(px, 0.8, py))
      for (const h of [0.5, 1.0, 1.5]) wirePts.push(new THREE.Vector3(px, h, py))
      if (i % 44 === 0 && rnd() < 0.7) {
        const b = new THREE.Mesh(bannerGeo, sponsorMats[bannerIdx++ % sponsorMats.length])
        b.position.set(px, 0.85, py)
        b.rotation.y = -p.heading
        this.scene.add(b)
      }
    }
    const fencePostMesh = new THREE.InstancedMesh(fencePostGeo, new THREE.MeshStandardMaterial({ color: 0x555555, metalness: 0.5 }), fencePosts.length)
    fencePosts.forEach((m, i) => fencePostMesh.setMatrixAt(i, m))
    this.scene.add(fencePostMesh)
    for (let h = 0; h < 3; h++) {
      const pts = wirePts.filter((_, i) => i % 3 === h)
      pts.push(pts[0].clone())
      this.scene.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color: 0x777777 })))
    }

    // --- Vehículos del público: clásicos argentinos sobre el terraplén y en el paddock ---
    type VType = 'falcon' | 'chevy' | 'torino' | 'taunus' | 'p504' | 'c3cv' | 'mehari' | 'rastrojero' | 'f100' | 'mb1114'
    interface Placement {
      type: VType
      x: number
      y: number
      y0: number
      rot: number
      color: number
    }
    const placements: Placement[] = []
    const people: { x: number; y: number; y0: number; color: number; rot: number; walk?: { dx: number; dz: number; amp: number; speed: number; phase: number } }[] = []
    const grills: { x: number; y: number; y0: number }[] = []
    const flags: { x: number; y: number; y0: number; color: number; text?: string }[] = []
    const ringSpot = (i: number, extra: number) => {
      const p = t.points[i]
      const nx = -Math.sin(p.heading)
      const ny = Math.cos(p.heading)
      const outward = outwardAt(p)
      const off = half + 19 + extra
      return { x: p.x + nx * off * outward, y: p.y + ny * off * outward, heading: p.heading, outward, nx, ny }
    }
    const classicPalette: Record<VType, number[]> = {
      falcon: [0xe8e2cf, 0x8fa9c9, 0x3b6e3a, 0xb8322b, 0xd9c36c, 0xf2f2f2, 0x2b2b2b],
      chevy: [0xd9d9d9, 0x9c1b1b, 0x2a4b8f, 0xd4a017, 0x3b3b3b, 0xe8e2cf],
      torino: [0xb8322b, 0xf2f2f2, 0x1f2a44, 0xd4a017, 0x5a8f5a],
      taunus: [0xc9c9c9, 0x2f6db5, 0xd9c36c, 0xb8322b, 0x7a5c3a],
      p504: [0xf2f2f2, 0xb8b8b8, 0x2b4a2b, 0x8c1d1d, 0xc9a86a],
      c3cv: [0xbfbfbf, 0xe8e2cf, 0xf5a623, 0x8fa9c9, 0x9bc1a0],
      mehari: [0xf5a623, 0x6aa84f, 0xe8e2cf, 0xffd500, 0xd42020],
      rastrojero: [0xb8322b, 0x2f6db5, 0x9a9a9a, 0x3b6e3a],
      f100: [0x2f6db5, 0xd9d9d9, 0x8c1d1d, 0x3b6e3a, 0xd4a017],
      mb1114: [0xf5a623, 0x2f6db5, 0xd42020, 0x2bb3a0],
    }
    const pickType = (paddock: boolean): VType => {
      const r = rnd()
      if (paddock) {
        if (r < 0.25) return 'f100'
        if (r < 0.4) return 'mb1114'
        if (r < 0.55) return 'rastrojero'
      }
      if (r < 0.18) return 'falcon'
      if (r < 0.3) return 'chevy'
      if (r < 0.4) return 'torino'
      if (r < 0.5) return 'taunus'
      if (r < 0.6) return 'p504'
      if (r < 0.68) return 'c3cv'
      if (r < 0.74) return 'mehari'
      if (r < 0.84) return 'rastrojero'
      if (r < 0.94) return 'f100'
      return 'mb1114'
    }
    const colorFor = (type: VType) => classicPalette[type][Math.floor(rnd() * classicPalette[type].length)]
    for (let i = 0; i < n; i += 6) {
      if (rnd() < 0.1) continue
      const spot = ringSpot(i, rnd() * 6)
      const type = pickType(false)
      const rot = -spot.heading + Math.PI / 2 + (rnd() - 0.5) * 0.35
      placements.push({ type, x: spot.x, y: spot.y, y0: EMB_Y, rot, color: colorFor(type) })
      // Gente alrededor del vehículo, mirando a la pista; algunos caminan por el terraplén.
      const group = 1 + Math.floor(rnd() * 4)
      for (let g = 0; g < group; g++) {
        const along = (rnd() - 0.5) * 5
        const toward = 3 + rnd() * 2
        const walking = rnd() < 0.22
        people.push({
          x: spot.x + Math.cos(spot.heading) * along - spot.nx * toward * spot.outward,
          y: spot.y + Math.sin(spot.heading) * along - spot.ny * toward * spot.outward,
          y0: EMB_Y,
          color: [0xffffff, 0x1f2a44, 0x8c1d1d, 0x2a7f3a, 0xf2c94c, 0x222222, 0x5b8fd6, 0x74acdf][Math.floor(rnd() * 8)],
          rot: -spot.heading + (spot.outward > 0 ? Math.PI / 2 : -Math.PI / 2),
          walk: walking ? { dx: Math.cos(spot.heading), dz: Math.sin(spot.heading), amp: 4 + rnd() * 6, speed: 0.25 + rnd() * 0.2, phase: rnd() * 6.28 } : undefined,
        })
      }
      if (type === 'mb1114') {
        // Gente arriba de la caja del camión.
        const fx = Math.cos(-rot)
        const fz = Math.sin(-rot)
        for (let g = 0; g < 3; g++) {
          people.push({ x: spot.x - fx * 1.2 + (rnd() - 0.5) * 4, y: spot.y - fz * 1.2 + (rnd() - 0.5) * 1.2, y0: EMB_Y + 2.9, color: [0xffffff, 0x1f2a44, 0x8c1d1d, 0xf2c94c][g % 4], rot })
        }
      }
      if (rnd() < 0.35) grills.push({ x: spot.x + Math.cos(spot.heading) * 3.5, y: spot.y + Math.sin(spot.heading) * 3.5, y0: EMB_Y })
      if (rnd() < 0.12) flags.push({ x: spot.x + spot.nx * 4 * spot.outward, y: spot.y + spot.ny * 4 * spot.outward, y0: EMB_Y, color: [0x74acdf, 0xffffff, 0xd42020, 0xf2c94c][Math.floor(rnd() * 4)] })
    }
    // Banderas grandes con nombres de pilotos, en la recta principal y en el curvón.
    const named: [number, string, string, string][] = [
      [n - 70, 'OLIVERA', '#d4202a', '#ffffff'],
      [n - 140, 'CARRERAS', '#1d5bd8', '#ffffff'],
      [n - 250, 'DEL POZO', '#c9ccd1', '#1f5fd6'],
    ]
    for (const [idx, text, bg, fg] of named) {
      const spot = ringSpot(idx, -3)
      flags.push({ x: spot.x, y: spot.y, y0: EMB_Y, color: 0xffffff, text: `${text}|${bg}|${fg}` })
    }
    // Paddock: filas de autos, camionetas y camiones.
    const pd = this.paddock
    for (let r = -3; r <= 3; r++) {
      for (let c = -12; c <= 12; c++) {
        if (rnd() < 0.3) continue
        const along = c * 11 + (rnd() - 0.5) * 3
        const across = r * 12 + (rnd() - 0.5) * 3
        const type = pickType(true)
        placements.push({
          type,
          x: pd.cx + pd.ax * along - pd.ay * across,
          y: pd.cy + pd.ay * along + pd.ax * across,
          y0: 0,
          rot: -Math.atan2(pd.ay, pd.ax) + (rnd() < 0.5 ? 0 : Math.PI / 2) + (rnd() - 0.5) * 0.3,
          color: colorFor(type),
        })
      }
    }

    // Piezas de cada tipo (x adelante, y arriba, z derecha); la primera pieza lleva el color.
    interface Part {
      geo: THREE.BufferGeometry
      mat: THREE.MeshStandardMaterial
      off: [number, number, number]
      colored?: boolean
    }
    const paintMat = () => new THREE.MeshStandardMaterial({ roughness: 0.4, metalness: 0.35 })
    const glassM = new THREE.MeshStandardMaterial({ color: 0x2a3340, roughness: 0.2, metalness: 0.5 })
    const woodM = new THREE.MeshStandardMaterial({ color: 0x7a5a3a, roughness: 0.9 })
    const darkM = new THREE.MeshStandardMaterial({ color: 0x333333, roughness: 0.8 })
    const chromeM = new THREE.MeshStandardMaterial({ color: 0xcccccc, roughness: 0.3, metalness: 0.8 })
    const box = (x: number, y: number, z: number) => new THREE.BoxGeometry(x, y, z)
    const roofGeo3cv = new THREE.CylinderGeometry(0.72, 0.72, 2.2, 12, 1, false, 0, Math.PI)
    roofGeo3cv.rotateZ(Math.PI / 2)
    roofGeo3cv.rotateY(Math.PI / 2)
    roofGeo3cv.scale(1, 0.55, 1)
    const cabGeo1114 = new THREE.BoxGeometry(2.2, 2.1, 2.3)
    const vehicleParts: Record<VType, { parts: Part[]; wheelR: number; wb: number; tw: number }> = {
      falcon: { parts: [{ geo: box(4.7, 0.6, 1.78), mat: paintMat(), off: [0, 0.72, 0], colored: true }, { geo: box(2.2, 0.6, 1.62), mat: glassM, off: [-0.1, 1.32, 0] }, { geo: box(0.1, 0.12, 1.5), mat: chromeM, off: [2.35, 0.55, 0] }], wheelR: 0.34, wb: 1.45, tw: 0.8 },
      chevy: { parts: [{ geo: box(4.9, 0.62, 1.82), mat: paintMat(), off: [0, 0.72, 0], colored: true }, { geo: box(2.1, 0.58, 1.64), mat: glassM, off: [-0.2, 1.32, 0] }, { geo: box(0.1, 0.12, 1.6), mat: chromeM, off: [2.45, 0.55, 0] }], wheelR: 0.35, wb: 1.5, tw: 0.82 },
      torino: { parts: [{ geo: box(4.75, 0.6, 1.78), mat: paintMat(), off: [0, 0.72, 0], colored: true }, { geo: box(2.0, 0.56, 1.6), mat: glassM, off: [-0.35, 1.3, 0] }, { geo: box(0.1, 0.12, 1.5), mat: chromeM, off: [2.37, 0.55, 0] }], wheelR: 0.34, wb: 1.45, tw: 0.8 },
      taunus: { parts: [{ geo: box(4.4, 0.58, 1.7), mat: paintMat(), off: [0, 0.7, 0], colored: true }, { geo: box(2.1, 0.58, 1.55), mat: glassM, off: [-0.1, 1.28, 0] }], wheelR: 0.32, wb: 1.35, tw: 0.76 },
      p504: { parts: [{ geo: box(4.5, 0.6, 1.7), mat: paintMat(), off: [0, 0.72, 0], colored: true }, { geo: box(2.2, 0.6, 1.55), mat: glassM, off: [-0.05, 1.32, 0] }], wheelR: 0.33, wb: 1.4, tw: 0.76 },
      c3cv: { parts: [{ geo: box(3.8, 0.7, 1.5), mat: paintMat(), off: [0, 0.78, 0], colored: true }, { geo: roofGeo3cv, mat: paintMat(), off: [-0.2, 1.13, 0], colored: true }, { geo: box(1.2, 0.5, 1.4), mat: glassM, off: [0.7, 1.3, 0] }], wheelR: 0.3, wb: 1.2, tw: 0.66 },
      mehari: { parts: [{ geo: box(3.5, 0.7, 1.5), mat: paintMat(), off: [0, 0.72, 0], colored: true }, { geo: box(0.08, 0.8, 1.5), mat: darkM, off: [-0.4, 1.45, 0] }, { geo: box(0.06, 0.5, 1.4), mat: glassM, off: [0.55, 1.3, 0] }], wheelR: 0.3, wb: 1.15, tw: 0.66 },
      rastrojero: { parts: [{ geo: box(1.6, 0.95, 1.6), mat: paintMat(), off: [0.9, 1.25, 0], colored: true }, { geo: box(1.1, 0.5, 1.5), mat: paintMat(), off: [2.05, 0.95, 0], colored: true }, { geo: box(2.3, 0.5, 1.6), mat: woodM, off: [-1.0, 0.98, 0] }, { geo: box(4.2, 0.4, 1.5), mat: darkM, off: [0, 0.6, 0] }, { geo: box(0.05, 0.5, 1.4), mat: glassM, off: [1.65, 1.45, 0] }], wheelR: 0.32, wb: 1.4, tw: 0.72 },
      f100: { parts: [{ geo: box(5.3, 0.55, 1.95), mat: paintMat(), off: [0, 0.7, 0], colored: true }, { geo: box(1.9, 0.5, 1.85), mat: paintMat(), off: [1.6, 1.22, 0], colored: true }, { geo: box(1.7, 0.9, 1.85), mat: paintMat(), off: [0.15, 1.45, 0], colored: true }, { geo: box(1.6, 0.5, 1.7), mat: glassM, off: [0.15, 1.65, 0] }, { geo: box(2.5, 0.55, 1.9), mat: paintMat(), off: [-1.4, 1.22, 0], colored: true }, { geo: box(0.12, 0.2, 1.9), mat: chromeM, off: [2.65, 0.6, 0] }], wheelR: 0.4, wb: 1.7, tw: 0.86 },
      mb1114: { parts: [{ geo: cabGeo1114, mat: paintMat(), off: [2.8, 1.95, 0], colored: true }, { geo: box(8, 0.5, 2.3), mat: darkM, off: [0, 0.75, 0] }, { geo: box(5.4, 1.9, 2.3), mat: woodM, off: [-1.2, 1.95, 0] }, { geo: box(0.05, 0.9, 2.1), mat: glassM, off: [3.9, 2.3, 0] }, { geo: box(0.1, 0.4, 2.3), mat: chromeM, off: [3.95, 0.8, 0] }], wheelR: 0.5, wb: 2.6, tw: 1.0 },
    }
    // Detalles comunes: paragolpes cromados, faros, luces traseras y espejos.
    const dims: Record<VType, { L: number; W: number; lightY: number; cabX: number; cabY: number }> = {
      falcon: { L: 4.7, W: 1.78, lightY: 0.82, cabX: -0.1, cabY: 1.32 },
      chevy: { L: 4.9, W: 1.82, lightY: 0.82, cabX: -0.2, cabY: 1.32 },
      torino: { L: 4.75, W: 1.78, lightY: 0.82, cabX: -0.35, cabY: 1.3 },
      taunus: { L: 4.4, W: 1.7, lightY: 0.8, cabX: -0.1, cabY: 1.28 },
      p504: { L: 4.5, W: 1.7, lightY: 0.82, cabX: -0.05, cabY: 1.32 },
      c3cv: { L: 3.8, W: 1.5, lightY: 0.95, cabX: 0.7, cabY: 1.3 },
      mehari: { L: 3.5, W: 1.5, lightY: 0.9, cabX: 0.55, cabY: 1.3 },
      rastrojero: { L: 4.2, W: 1.6, lightY: 0.95, cabX: 0.9, cabY: 1.45 },
      f100: { L: 5.3, W: 1.95, lightY: 1.05, cabX: 0.15, cabY: 1.65 },
      mb1114: { L: 8, W: 2.3, lightY: 1.1, cabX: 2.8, cabY: 2.4 },
    }
    const lampM = new THREE.MeshStandardMaterial({ color: 0xfff2c0, emissive: 0xffe6a0, emissiveIntensity: 0.6, roughness: 0.3 })
    const tailM = new THREE.MeshStandardMaterial({ color: 0xd42020, emissive: 0x800000, emissiveIntensity: 0.4, roughness: 0.3 })
    for (const type of Object.keys(dims) as VType[]) {
      const d = dims[type]
      const spec = vehicleParts[type]
      spec.parts.push(
        { geo: box(0.12, 0.16, d.W * 0.98), mat: chromeM, off: [d.L / 2 + 0.05, 0.5, 0] },
        { geo: box(0.12, 0.16, d.W * 0.98), mat: chromeM, off: [-d.L / 2 - 0.05, 0.5, 0] },
        { geo: box(0.06, 0.16, 0.26), mat: lampM, off: [d.L / 2 + 0.03, d.lightY, d.W * 0.33] },
        { geo: box(0.06, 0.16, 0.26), mat: lampM, off: [d.L / 2 + 0.03, d.lightY, -d.W * 0.33] },
        { geo: box(0.06, 0.12, 0.22), mat: tailM, off: [-d.L / 2 - 0.03, d.lightY, d.W * 0.36] },
        { geo: box(0.06, 0.12, 0.22), mat: tailM, off: [-d.L / 2 - 0.03, d.lightY, -d.W * 0.36] },
        { geo: box(0.12, 0.1, 0.1), mat: chromeM, off: [d.cabX + 0.7, d.cabY + 0.05, d.W / 2 + 0.1] },
        { geo: box(0.12, 0.1, 0.1), mat: chromeM, off: [d.cabX + 0.7, d.cabY + 0.05, -d.W / 2 - 0.1] },
      )
    }
    const wheelSetGeo = new THREE.CylinderGeometry(1, 1, 0.26, 12)
    wheelSetGeo.rotateX(Math.PI / 2)
    const allVehicleWheels: THREE.Matrix4[] = []
    const addWheels = (x: number, y: number, y0: number, rot: number, wb: number, tw: number, r: number) => {
      const fx = Math.cos(-rot)
      const fz = Math.sin(-rot)
      for (const a of [-1, 1]) {
        for (const b of [-1, 1]) {
          allVehicleWheels.push(
            new THREE.Matrix4().compose(
              new THREE.Vector3(x + fx * a * wb - fz * b * tw, y0 + r, y + fz * a * wb + fx * b * tw),
              new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), rot),
              new THREE.Vector3(r, r, 1),
            ),
          )
        }
      }
    }
    for (const type of Object.keys(vehicleParts) as VType[]) {
      const list = placements.filter((pl) => pl.type === type)
      if (!list.length) continue
      const spec = vehicleParts[type]
      for (const part of spec.parts) {
        const mesh = new THREE.InstancedMesh(part.geo, part.mat, list.length)
        list.forEach((pl, i) => {
          const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), pl.rot)
          const fx = Math.cos(-pl.rot)
          const fz = Math.sin(-pl.rot)
          const ox = part.off[0]
          const oz = part.off[2]
          mesh.setMatrixAt(i, new THREE.Matrix4().compose(new THREE.Vector3(pl.x + fx * ox - fz * oz, pl.y0 + part.off[1], pl.y + fz * ox + fx * oz), q, new THREE.Vector3(1, 1, 1)))
          if (part.colored) mesh.setColorAt(i, new THREE.Color(pl.color))
        })
        mesh.castShadow = true
        this.scene.add(mesh)
      }
      list.forEach((pl) => addWheels(pl.x, pl.y, pl.y0, pl.rot, spec.wb, spec.tw, spec.wheelR))
    }
    const vWheels = new THREE.InstancedMesh(wheelSetGeo, rubberMat, allVehicleWheels.length)
    allVehicleWheels.forEach((m, i) => vWheels.setMatrixAt(i, m))
    this.scene.add(vWheels)

    // Público: figuras por partes (piernas, torso, brazos, cabeza y gorra),
    // con ropa de colores; algunos caminan por el terraplén.
    const crowd = new CrowdPeople(people.length)
    this.crowd = crowd
    this.scene.add(crowd.group)
    people.forEach((pp, i) => {
      const h = 0.9 + rnd() * 0.25
      const pants = [0x2a3a66, 0x111111, 0x8a7a5a, 0x3a3a3a, 0x5a6a8a][Math.floor(rnd() * 5)]
      const cap = rnd() < 0.5 ? [0x111111, 0xd42020, 0xffffff, 0x1f5fd6][Math.floor(rnd() * 4)] : -1
      crowd.setPerson(i, pp.x, pp.y0, pp.y, pp.rot, h, pp.color, pants, cap, 0)
      if (pp.walk) this.walkers.push({ index: i, x: pp.x, z: pp.y, y0: pp.y0, h, shirt: pp.color, pants, cap, ...pp.walk })
    })
    crowd.commit()

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
    const bigFlagGeo = new THREE.PlaneGeometry(2.6, 1.5, 8, 1)
    flags.forEach((f) => {
      const pole = new THREE.Mesh(poleGeo, hubMat)
      pole.position.set(f.x, f.y0 + 2, f.y)
      this.scene.add(pole)
      let mat: THREE.MeshStandardMaterial
      if (f.text) {
        const [txt, bg, fg] = f.text.split('|')
        mat = new THREE.MeshStandardMaterial({ map: makeBannerTexture(txt, bg, fg, 1024, 512), side: THREE.DoubleSide, roughness: 0.9 })
      } else {
        mat = new THREE.MeshStandardMaterial({ color: f.color, side: THREE.DoubleSide, roughness: 0.9 })
      }
      const flag = new THREE.Mesh(f.text ? bigFlagGeo : flagGeo, mat)
      flag.position.set(f.x + (f.text ? 1.3 : 0.7), f.y0 + 3.5, f.y)
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

    // Mangrullo de transmisión y fiscalización, a la izquierda de la largada
    // (lado exterior): bloque inferior con los paneles de la Municipalidad y
    // el banner de ACT, piso superior con baranda y gente con micrófono, y el
    // podio adelante.
    const s0 = t.points[0]
    const outward0 = outwardAt(s0)
    const tnx = -Math.sin(s0.heading)
    const tny = Math.cos(s0.heading)
    const mang = new THREE.Group()
    const whiteM = new THREE.MeshStandardMaterial({ color: 0xf2efe6, roughness: 0.85 })
    const lower = new THREE.Mesh(new THREE.BoxGeometry(3, 3.2, 8), whiteM)
    lower.position.set(0, 1.6, 0)
    lower.castShadow = true
    lower.receiveShadow = true
    mang.add(lower)
    // Cara hacia la pista (−X local): paneles GA a los lados y ACT al centro.
    const gaTex = makeGABanner()
    const gaMat = new THREE.MeshStandardMaterial({ map: gaTex, roughness: 0.8 })
    for (const z of [-2.9, 2.9]) {
      const panel = new THREE.Mesh(new THREE.PlaneGeometry(1.7, 3.0), gaMat)
      panel.position.set(-1.51, 1.6, z)
      panel.rotation.y = -Math.PI / 2
      mang.add(panel)
    }
    const act = new THREE.Mesh(new THREE.PlaneGeometry(3.6, 3.0), new THREE.MeshStandardMaterial({ map: makeACTBanner(), roughness: 0.8 }))
    act.position.set(-1.52, 1.65, 0)
    act.rotation.y = -Math.PI / 2
    mang.add(act)
    // Piso superior, baranda y casilla.
    const deck = new THREE.Mesh(new THREE.BoxGeometry(3.4, 0.15, 8.4), new THREE.MeshStandardMaterial({ color: 0x8a7a66, roughness: 0.9 }))
    deck.position.y = 3.27
    deck.castShadow = true
    mang.add(deck)
    const railMat = new THREE.MeshStandardMaterial({ color: 0x444444, metalness: 0.6, roughness: 0.5 })
    const railGeo = new THREE.CylinderGeometry(0.025, 0.025, 1, 6)
    const addRail = (a: THREE.Vector3, b: THREE.Vector3) => {
      const len = a.distanceTo(b)
      const m = new THREE.Mesh(railGeo, railMat)
      m.scale.y = len
      m.position.copy(a).lerp(b, 0.5)
      m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), b.clone().sub(a).normalize())
      mang.add(m)
    }
    for (let z = -4.2; z <= 4.2; z += 1.4) {
      addRail(new THREE.Vector3(-1.7, 3.35, z), new THREE.Vector3(-1.7, 4.45, z))
    }
    addRail(new THREE.Vector3(-1.7, 4.45, -4.2), new THREE.Vector3(-1.7, 4.45, 4.2))
    addRail(new THREE.Vector3(-1.7, 3.9, -4.2), new THREE.Vector3(-1.7, 3.9, 4.2))
    for (const z of [-4.2, 4.2]) {
      addRail(new THREE.Vector3(-1.7, 4.45, z), new THREE.Vector3(1.7, 4.45, z))
      addRail(new THREE.Vector3(1.7, 3.35, z), new THREE.Vector3(1.7, 4.45, z))
    }
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(8.4, 1.1), netMat)
    mesh.position.set(-1.7, 3.9, 0)
    mesh.rotation.y = -Math.PI / 2
    mang.add(mesh)
    const hut = new THREE.Mesh(new THREE.BoxGeometry(1.6, 2.3, 4), whiteM)
    hut.position.set(0.9, 4.5, -1.5)
    hut.castShadow = true
    mang.add(hut)
    const roofHut = new THREE.Mesh(new THREE.BoxGeometry(2.0, 0.08, 4.4), new THREE.MeshStandardMaterial({ color: 0x8a8f96, metalness: 0.6, roughness: 0.4 }))
    roofHut.position.set(0.8, 5.7, -1.5)
    roofHut.rotation.z = 0.12
    mang.add(roofHut)
    // Parlantes.
    for (const z of [-4.6, 4.6]) {
      const spk = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.9, 0.5), darkM)
      spk.position.set(-1.2, 0.45, z)
      mang.add(spk)
    }
    // Gente en el mangrullo: relator con micrófono y comisarios.
    const suitCols = [0x222222, 0xd42020, 0x1f2a44, 0x8c8c8c, 0xffffff, 0x2a7f3a]
    for (let k = 0; k < 6; k++) {
      const person = new THREE.Group()
      const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.2, 0.9, 3, 8), new THREE.MeshStandardMaterial({ color: suitCols[k], roughness: 0.9 }))
      body.position.y = 0.65
      person.add(body)
      const head = new THREE.Mesh(new THREE.SphereGeometry(0.13, 10, 8), new THREE.MeshStandardMaterial({ color: 0xc8956c }))
      head.position.y = 1.42
      person.add(head)
      const cap = new THREE.Mesh(new THREE.SphereGeometry(0.14, 10, 6, 0, Math.PI * 2, 0, Math.PI / 2), new THREE.MeshStandardMaterial({ color: k % 2 ? 0x111111 : 0xd42020 }))
      cap.position.y = 1.44
      person.add(cap)
      if (k === 1) {
        const mic = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.25, 6), darkM)
        mic.position.set(-0.25, 1.25, 0.05)
        mic.rotation.z = 0.5
        person.add(mic)
      }
      person.position.set(-1.1, 3.35, -3.5 + k * 1.4)
      person.rotation.y = -Math.PI / 2
      mang.add(person)
    }
    // Podio.
    const podiumTex = (num: string, col: string) => {
      const c = document.createElement('canvas')
      c.width = 256
      c.height = 256
      const ctx = c.getContext('2d')!
      ctx.fillStyle = '#f4f4f4'
      ctx.fillRect(0, 0, 256, 256)
      ctx.fillStyle = col
      ctx.beginPath()
      ctx.arc(128, 128, 80, 0, Math.PI * 2)
      ctx.fill()
      ctx.fillStyle = '#ffffff'
      ctx.font = '900 110px sans-serif'
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillText(num, 128, 134)
      return new THREE.MeshStandardMaterial({ map: canvasTexture(c, false), roughness: 0.9 })
    }
    const podium: [string, string, number, number][] = [
      ['1', '#d4a017', 1.0, 0],
      ['2', '#9a9a9a', 0.7, -1.3],
      ['3', '#b87333', 0.5, 1.3],
    ]
    for (const [num, col, hgt, z] of podium) {
      const step = new THREE.Mesh(new THREE.BoxGeometry(1.2, hgt, 1.2), [whiteM, whiteM, whiteM, whiteM, podiumTex(num, col), whiteM])
      step.position.set(-2.6, hgt / 2, z)
      step.castShadow = true
      mang.add(step)
    }
    // Ubicación: junto a la largada, del lado exterior, mirando a la pista.
    const mangOff = half + 7.4
    mang.position.set(s0.x + Math.cos(s0.heading) * 6 + tnx * mangOff * outward0, 0, s0.y + Math.sin(s0.heading) * 6 + tny * mangOff * outward0)
    // La cara −X local debe mirar a la pista: girar según el lado.
    mang.rotation.y = Math.atan2(-tny * outward0, tnx * outward0)
    this.scene.add(mang)

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

  /**
   * Cámara de la previa: vista cenital del circuito, descenso, vuelo a ras de
   * pista pasando junto a los autos en la grilla y llegada detrás del jugador.
   */
  private introCamera(t: number, total: number, player: Car): { pos: THREE.Vector3; look: THREE.Vector3 } {
    const smooth = (a: number, b: number, x: number) => {
      const k = THREE.MathUtils.clamp((x - a) / (b - a), 0, 1)
      return k * k * (3 - 2 * k)
    }
    const cx = this.center.x
    const cz = this.center.y
    const n = this.track.points.length
    // Tiempos de las etapas: cenital, vuelo por el final de la vuelta,
    // travelling lateral por la grilla (una tarjeta por piloto) y llegada.
    const tA = 8 // fin de la cenital
    const tB = 22 // fin del vuelo, llegada a la línea de largada
    const tC = total - 7 // fin del travelling por la grilla

    // A: cenital, orbitando despacio y bajando un poco.
    const ang = 0.6 + t * 0.03
    const h = 430 - 120 * THREE.MathUtils.clamp(t / tA, 0, 1)
    const cenPos = new THREE.Vector3(cx + Math.sin(ang) * 70, h, cz + Math.cos(ang) * 70)
    const cenLook = new THREE.Vector3(cx, 0, cz)

    // B: vuelo a ras de pista por el último tramo de la vuelta hasta la largada.
    const uB = smooth(tA - 1, tB, t)
    const idxB = n - 430 + 428 * uB
    const pB = this.track.pointAtF(idxB)
    const aB = this.track.pointAtF(idxB + 24)
    const sideB = -this.track.outwardAt(Math.round(idxB))
    const nxB = -Math.sin(pB.heading)
    const nyB = Math.cos(pB.heading)
    const flyPos = new THREE.Vector3(pB.x + nxB * 4.5 * sideB, this.track.groundHeight(pB.x, pB.y) + 3.0, pB.y + nyB * 4.5 * sideB)
    const flyLook = new THREE.Vector3(aB.x, 1.0, aB.y)

    // C: travelling lateral desde la primera fila hacia atrás, mirando los autos de costado.
    const uC = THREE.MathUtils.clamp((t - tB) / (tC - tB), 0, 1)
    const idxC = n - 6 - 46 * uC
    const pC = this.track.pointAtF(idxC)
    const nxC = -Math.sin(pC.heading)
    const nyC = Math.cos(pC.heading)
    const sideC = -this.track.outwardAt(Math.round(idxC))
    const dollyPos = new THREE.Vector3(pC.x + nxC * 8.5 * sideC, this.track.groundHeight(pC.x, pC.y) + 1.35, pC.y + nyC * 8.5 * sideC)
    const pC2 = this.track.pointAtF(idxC + 1.5)
    const dollyLook = new THREE.Vector3(pC2.x - nxC * 1.5 * sideC, 0.75, pC2.y - nyC * 1.5 * sideC)

    // D: posición final de persecución detrás del jugador.
    const fx = Math.cos(player.heading)
    const fz = Math.sin(player.heading)
    const chasePos = new THREE.Vector3(player.x - fx * 7.5, player.height + 2.8, player.y - fz * 7.5)
    const chaseLook = new THREE.Vector3(player.x + fx * 6, player.height + 0.9, player.y + fz * 6)

    const kAB = smooth(tA - 2, tA + 2, t)
    const kBC = smooth(tB - 1.5, tB + 1.5, t)
    const kCD = smooth(tC, total, t)
    const pos = cenPos.clone().lerp(flyPos, kAB).lerp(dollyPos, kBC).lerp(chasePos, kCD)
    const look = cenLook.clone().lerp(flyLook, kAB).lerp(dollyLook, kBC).lerp(chaseLook, kCD)
    return { pos, look }
  }

  /** Fondo del menú: paneo lento a baja altura por la grilla y el mangrullo. */
  renderMenu(cars: Car[], t: number, dt: number) {
    this.time += dt
    for (const c of cars) {
      const v = this.views.get(c.id)!
      v.group.position.set(c.x, c.height, c.y)
      v.group.rotation.y = -c.heading
    }
    for (const f of this.flags) f.rotation.y = Math.sin(this.time * 2 + (f.userData.phase as number)) * 0.25
    this.updateWalkers()
    for (const sp of this.smoke) {
      const a = (this.time * 0.18 + (sp.userData.phase as number)) % 1
      const base = sp.userData.base as THREE.Vector3
      sp.position.set(base.x + (sp.userData.drift as number) * a * 6, base.y + a * 7, base.z + a * 2)
      sp.scale.setScalar(0.6 + a * 3.5)
      ;(sp.material as THREE.SpriteMaterial).opacity = 0.4 * (1 - a) * Math.min(1, a * 6)
    }
    const n = this.track.points.length
    // Órbita lenta alrededor del centro de la grilla, alternando altura.
    const grid = this.track.pointAtF(n - 42)
    const ang = 0.9 + t * 0.04
    const r = 24
    const pos = new THREE.Vector3(grid.x + Math.cos(ang) * r, 3.4 + Math.sin(t * 0.2) * 1.0, grid.y + Math.sin(ang) * r)
    const look = new THREE.Vector3(grid.x, 0.8, grid.y)
    this.camera.position.copy(pos)
    this.camera.lookAt(look)
    this.camera.fov = 48
    this.camera.updateProjectionMatrix()
    this.camPos.copy(pos)
    this.camTarget.copy(look)
    this.sun.position.set(grid.x - 130, 48, grid.y - 90)
    this.sun.target.position.set(grid.x, 0, grid.y)
    this.sun.target.updateMatrixWorld()
    this.grade.uniforms.time.value = this.time % 100
    this.composer.render()
  }

  /** Cámara de la previa, llamada por el bucle principal mientras dura. */
  renderIntro(cars: Car[], player: Car, t: number, total: number, dt: number) {
    this.time += dt
    for (const c of cars) {
      const v = this.views.get(c.id)!
      v.group.position.set(c.x, c.height, c.y)
      v.group.rotation.y = -c.heading
    }
    for (const f of this.flags) f.rotation.y = Math.sin(this.time * 2 + (f.userData.phase as number)) * 0.25
    this.updateWalkers()
    for (const sp of this.smoke) {
      const a = (this.time * 0.18 + (sp.userData.phase as number)) % 1
      const base = sp.userData.base as THREE.Vector3
      sp.position.set(base.x + (sp.userData.drift as number) * a * 6, base.y + a * 7, base.z + a * 2)
      sp.scale.setScalar(0.6 + a * 3.5)
      ;(sp.material as THREE.SpriteMaterial).opacity = 0.4 * (1 - a) * Math.min(1, a * 6)
    }
    const { pos, look } = this.introCamera(t, total, player)
    this.camPos.copy(pos)
    this.camTarget.copy(look)
    this.first = false
    this.camera.position.copy(pos)
    this.camera.lookAt(look)
    const fov = t < 8 ? 50 : t < 22 ? 66 : t < total - 7 ? 42 : 62
    this.camera.fov += (fov - this.camera.fov) * Math.min(1, dt * 2)
    this.camera.updateProjectionMatrix()
    this.sun.position.set(player.x - 130, 48, player.y - 90)
    this.sun.target.position.set(player.x, 0, player.y)
    this.sun.target.updateMatrixWorld()
    this.grade.uniforms.time.value = this.time % 100
    this.composer.render()
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
    this.updateWalkers()
    for (const c of cars) {
      const v = this.views.get(c.id)!
      v.group.position.set(c.x, c.height, c.y)
      v.group.rotation.y = -c.heading
      this.updateSuspension(c, v, dt)
      for (const fw of v.frontWheels) fw.rotation.y = -c.steerAngle
      const spin = (c.speed * dt) / 0.36
      for (const w of v.wheels) w.rotation.z -= spin
      for (const mw of v.modelWheels) {
        mw.mesh.rotation.z -= (c.speed * dt) / mw.radius
        if (mw.front) mw.pivot.rotation.y = -c.steerAngle
      }
      this.updateDust(c, v, dt)
      this.updateMarks(c, v, dt)
    }

    // Cámara: campo visual que se abre con la velocidad y leve vibración en la tierra.
    const fx = Math.cos(player.heading)
    const fz = Math.sin(player.heading)
    let desired: THREE.Vector3
    let look: THREE.Vector3
    const hy = player.height
    if (this.cameraMode === 'far') {
      desired = new THREE.Vector3(player.x - fx * 16, hy + 9, player.y - fz * 16)
      look = new THREE.Vector3(player.x + fx * 8, hy + 0.5, player.y + fz * 8)
    } else if (this.cameraMode === 'hood') {
      desired = new THREE.Vector3(player.x - fx * 0.3, hy + 1.55, player.y - fz * 0.3)
      look = new THREE.Vector3(player.x + fx * 30, hy + 1.0, player.y + fz * 30)
    } else {
      const back = 7.5 + player.speed * 0.06
      desired = new THREE.Vector3(player.x - fx * back, hy + 2.8 + player.speed * 0.01, player.y - fz * back)
      look = new THREE.Vector3(player.x + fx * 6, hy + 0.9, player.y + fz * 6)
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
    this.sun.position.set(player.x - 130, 48, player.y - 90)
    this.sun.target.position.set(player.x, 0, player.y)
    this.sun.target.updateMatrixWorld()

    this.grade.uniforms.time.value = this.time % 100
    this.composer.render()
  }

  /** Gente que camina de un lado a otro por el terraplén. */
  private updateWalkers() {
    if (!this.crowd || this.walkers.length === 0) return
    for (const w of this.walkers) {
      const s = Math.sin(this.time * w.speed + w.phase)
      const dirSign = Math.cos(this.time * w.speed + w.phase) >= 0 ? 1 : -1
      const x = w.x + w.dx * w.amp * s
      const z = w.z + w.dz * w.amp * s
      const rot = -Math.atan2(w.dz * dirSign, w.dx * dirSign)
      const swing = Math.sin(this.time * 7 + w.phase) * 0.5
      this.crowd.setPerson(w.index, x, w.y0, z, rot, w.h, w.shirt, w.pants, w.cap, swing)
    }
    this.crowd.commit()
  }

  /** Ondulaciones de la tierra (metros) en un punto del mundo. */
  private groundBump(x: number, z: number, onTrack: boolean): number {
    const a = onTrack ? 0.02 : 0.06
    return (
      a *
      (Math.sin(x * 0.9 + z * 0.35) * Math.sin(x * 0.27 - z * 0.8) +
        0.7 * Math.sin(x * 1.7 + z * 1.3) * Math.cos(x * 1.1 - z * 1.9) +
        0.35 * Math.sin(x * 3.1 + z * 2.6))
    )
  }

  /**
   * Suspensión: cada rueda sigue el relieve de la tierra; la carrocería
   * responde con resorte y amortiguador en altura, cabeceo y rolido, más el
   * cabeceo al acelerar o frenar y el rolido en las curvas.
   */
  private updateSuspension(c: Car, v: CarView, dt: number) {
    if (dt <= 0) return
    const cos = Math.cos(c.heading)
    const sin = Math.sin(c.heading)
    let sum = 0
    let front = 0
    let rear = 0
    let left = 0
    let right = 0
    let nf = 0
    let nr = 0
    let nl = 0
    let nrg = 0
    for (const w of v.wheelNodes) {
      const wx = c.x + w.x * cos - w.z * sin
      const wz = c.y + w.x * sin + w.z * cos
      const h = THREE.MathUtils.clamp(this.track.groundHeight(wx, wz, c.trackIndex) - c.height, -0.25, 0.25) + this.groundBump(wx, wz, c.onAsphalt)
      w.node.position.y = w.baseY + h
      sum += h
      if (w.x > 0) {
        front += h
        nf++
      } else {
        rear += h
        nr++
      }
      if (w.z < 0) {
        left += h
        nl++
      } else {
        right += h
        nrg++
      }
    }
    const n = Math.max(1, v.wheelNodes.length)
    const s = v.susp
    const accel = (c.speed - s.prevSpeed) / dt
    let yawRate = (c.heading - s.prevHeading) / dt
    if (yawRate > Math.PI) yawRate -= 2 * Math.PI / dt
    if (yawRate < -Math.PI) yawRate += 2 * Math.PI / dt
    s.prevSpeed = c.speed
    s.prevHeading = c.heading
    const latAccel = THREE.MathUtils.clamp(c.speed * yawRate, -12, 12)
    const longAccel = THREE.MathUtils.clamp(accel, -12, 12)

    const heaveT = sum / n
    const pitchT = Math.atan((front / Math.max(1, nf) - rear / Math.max(1, nr)) / 2.8) + longAccel * 0.004
    const rollT = Math.atan((left / Math.max(1, nl) - right / Math.max(1, nrg)) / 1.7) - latAccel * 0.006

    const step = (x: number, vel: number, target: number, k: number, damp: number): [number, number] => {
      const a = k * (target - x) - damp * vel
      vel += a * dt
      x += vel * dt
      return [x, vel]
    }
    ;[s.heave, s.heaveV] = step(s.heave, s.heaveV, heaveT, 90, 12)
    ;[s.pitch, s.pitchV] = step(s.pitch, s.pitchV, pitchT, 80, 11)
    ;[s.roll, s.rollV] = step(s.roll, s.rollV, rollT, 80, 11)
    v.bodyNode.position.y = s.heave
    v.bodyNode.rotation.z = s.pitch
    v.bodyNode.rotation.x = s.roll
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
      this.tmpPos.set(c.x - fx * L * 0.4 - fz * side * W * 0.52, c.height + 0.05, c.y - fz * L * 0.4 + fx * side * W * 0.52)
      this.tmpMatrix.compose(this.tmpPos, this.tmpQuat, this.tmpScale)
      this.marks.setMatrixAt(slot, this.tmpMatrix)
    }
    this.marks.instanceMatrix.needsUpdate = true
  }

  private updateDust(c: Car, v: CarView, dt: number) {
    const sliding = Math.abs(c.lateralSpeed) > 1.5
    const rate = c.speed > 4 ? (sliding ? 40 : 12) * (c.onAsphalt ? 1 : 1.6) : 0
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
        sprite.position.set(c.x - fx * 1.5 - fz * side * 0.9, c.height + 0.35, c.y - fz * 1.5 + fx * side * 0.9)
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
      s.scale.setScalar(0.9 + a * 4)
      ;(s.material as THREE.SpriteMaterial).opacity = 0.32 * (1 - a) * (1 - a)
    }
  }

  dispose() {
    this.renderer.dispose()
  }
}


/**
 * Público por partes con instancias: piernas, torso, brazos, cabeza y gorra.
 * `setPerson` ubica una figura; `swing` balancea brazos y piernas al caminar.
 */
class CrowdPeople {
  readonly group = new THREE.Group()
  private legs: THREE.InstancedMesh
  private torso: THREE.InstancedMesh
  private arms: THREE.InstancedMesh
  private head: THREE.InstancedMesh
  private cap: THREE.InstancedMesh
  private m = new THREE.Matrix4()
  private q = new THREE.Quaternion()
  private p = new THREE.Vector3()
  private sc = new THREE.Vector3()
  private col = new THREE.Color()

  constructor(count: number) {
    const legGeo = new THREE.BoxGeometry(0.13, 0.82, 0.15)
    legGeo.translate(0, 0.41, 0)
    const torsoGeo = new THREE.BoxGeometry(0.42, 0.56, 0.24)
    const armGeo = new THREE.BoxGeometry(0.1, 0.5, 0.1)
    armGeo.translate(0, -0.25, 0)
    const headGeo = new THREE.SphereGeometry(0.12, 10, 8)
    const capGeo = new THREE.SphereGeometry(0.13, 10, 6, 0, Math.PI * 2, 0, Math.PI / 2)
    this.legs = new THREE.InstancedMesh(legGeo, new THREE.MeshStandardMaterial({ roughness: 0.9 }), count * 2)
    this.torso = new THREE.InstancedMesh(torsoGeo, new THREE.MeshStandardMaterial({ roughness: 0.9 }), count)
    this.arms = new THREE.InstancedMesh(armGeo, new THREE.MeshStandardMaterial({ roughness: 0.9 }), count * 2)
    this.head = new THREE.InstancedMesh(headGeo, new THREE.MeshStandardMaterial({ color: 0xc8956c, roughness: 0.8 }), count)
    this.cap = new THREE.InstancedMesh(capGeo, new THREE.MeshStandardMaterial({ roughness: 0.9 }), count)
    for (const mesh of [this.legs, this.torso, this.arms, this.head, this.cap]) {
      mesh.castShadow = true
      this.group.add(mesh)
    }
  }

  setPerson(i: number, x: number, y0: number, z: number, rot: number, h: number, shirt: number, pants: number, cap: number, swing: number) {
    const cos = Math.cos(rot)
    const sin = Math.sin(rot)
    // Un punto en el espacio local de la persona (adelante = +x local) a mundo.
    const local = (lx: number, ly: number, lz: number) => this.p.set(x + lx * cos + lz * sin, y0 + ly * h, z - lx * sin + lz * cos)
    this.q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), rot)
    this.sc.set(1, h, 1)
    // Piernas (balanceo opuesto).
    for (const side of [-1, 1]) {
      const swingQ = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), side * swing * 0.6)
      const qq = this.q.clone().multiply(swingQ)
      local(0, 0, side * 0.09)
      this.legs.setMatrixAt(i * 2 + (side > 0 ? 1 : 0), this.m.compose(this.p, qq, this.sc))
      this.legs.setColorAt(i * 2 + (side > 0 ? 1 : 0), this.col.setHex(pants))
    }
    local(0, 1.1, 0)
    this.torso.setMatrixAt(i, this.m.compose(this.p, this.q, this.sc))
    this.torso.setColorAt(i, this.col.setHex(shirt))
    for (const side of [-1, 1]) {
      const swingQ = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), -side * swing * 0.5)
      const qq = this.q.clone().multiply(swingQ)
      local(0, 1.36, side * 0.27)
      this.arms.setMatrixAt(i * 2 + (side > 0 ? 1 : 0), this.m.compose(this.p, qq, this.sc))
      this.arms.setColorAt(i * 2 + (side > 0 ? 1 : 0), this.col.setHex(shirt))
    }
    local(0, 1.52, 0)
    this.sc.set(1, 1, 1)
    this.head.setMatrixAt(i, this.m.compose(this.p, this.q, this.sc))
    if (cap >= 0) {
      local(0, 1.55, 0)
      this.cap.setMatrixAt(i, this.m.compose(this.p, this.q, this.sc))
      this.cap.setColorAt(i, this.col.setHex(cap))
    } else {
      this.cap.setMatrixAt(i, this.m.makeScale(0, 0, 0))
    }
  }

  commit() {
    for (const mesh of [this.legs, this.torso, this.arms, this.head, this.cap]) {
      mesh.instanceMatrix.needsUpdate = true
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true
    }
  }
}

/** Exportadas para previsualizar los banners en herramientas de desarrollo. */
export { makeACTBanner, makeGABanner }
