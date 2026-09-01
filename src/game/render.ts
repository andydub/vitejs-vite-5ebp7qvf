import type { Car } from './car'
import { Track } from './track'

/** Minimapa 2D que se dibuja sobre la escena 3D. */
export function drawMinimap(
  ctx: CanvasRenderingContext2D,
  track: Track,
  cars: Car[],
  x: number,
  y: number,
  size: number,
) {
  const { minX, minY, maxX, maxY } = track.bounds
  const w = maxX - minX
  const h = maxY - minY
  const scale = Math.min(size / w, size / h)
  ctx.save()
  ctx.globalAlpha = 0.9
  ctx.fillStyle = 'rgba(0,0,0,0.45)'
  ctx.fillRect(x - 6, y - 6, w * scale + 12, h * scale + 12)
  ctx.translate(x - minX * scale, y - minY * scale)
  ctx.scale(scale, scale)
  ctx.lineJoin = 'round'
  ctx.strokeStyle = '#ddd'
  ctx.lineWidth = track.width * 1.2
  ctx.beginPath()
  track.points.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)))
  ctx.closePath()
  ctx.stroke()
  for (const c of cars) {
    ctx.fillStyle = c.isPlayer ? '#fff' : c.color
    ctx.beginPath()
    ctx.arc(c.x, c.y, c.isPlayer ? 7 / scale : 5 / scale, 0, Math.PI * 2)
    ctx.fill()
    if (c.isPlayer) {
      ctx.strokeStyle = '#000'
      ctx.lineWidth = 2 / scale
      ctx.stroke()
    }
  }
  ctx.restore()
}
