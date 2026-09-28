import { useEffect, useMemo, useRef, useState } from 'react'
import { fmt, fmtDate } from './data'

export type ChartRow = {
  fecha: string
  real?: number
  mediana?: number
  p10?: number
  p90?: number
}

const HEIGHT = 340
const M = { top: 16, right: 16, bottom: 32, left: 64 }

function niceTicks(max: number, count = 5): number[] {
  const raw = max / count
  const mag = 10 ** Math.floor(Math.log10(raw))
  const step = [1, 2, 2.5, 5, 10].map((s) => s * mag).find((s) => s >= raw) ?? raw
  const ticks: number[] = []
  for (let v = 0; v <= max + step * 0.001; v += step) ticks.push(v)
  if (ticks[ticks.length - 1] < max) ticks.push(ticks[ticks.length - 1] + step)
  return ticks
}

function path(points: [number, number][]): string {
  return points.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`).join('')
}

export function SalesChart({ rows }: { rows: ChartRow[] }) {
  const wrapRef = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(800)
  const [hover, setHover] = useState<number | null>(null)

  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const ro = new ResizeObserver(([e]) => setWidth(e.contentRect.width))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const geo = useMemo(() => {
    const innerW = Math.max(width - M.left - M.right, 10)
    const innerH = HEIGHT - M.top - M.bottom
    const maxV = Math.max(1, ...rows.map((r) => Math.max(r.real ?? 0, r.p90 ?? 0, r.mediana ?? 0)))
    const ticks = niceTicks(maxV)
    const yMax = ticks[ticks.length - 1]
    const x = (i: number) => M.left + (rows.length > 1 ? (i / (rows.length - 1)) * innerW : 0)
    const y = (v: number) => M.top + innerH - (v / yMax) * innerH

    const hist: [number, number][] = []
    const med: [number, number][] = []
    const upper: [number, number][] = []
    const lower: [number, number][] = []
    let firstFc = -1
    rows.forEach((r, i) => {
      if (r.real !== undefined) hist.push([x(i), y(r.real)])
      if (r.mediana !== undefined) {
        if (firstFc < 0) firstFc = i
        med.push([x(i), y(r.mediana)])
        upper.push([x(i), y(r.p90 ?? r.mediana)])
        lower.push([x(i), y(r.p10 ?? r.mediana)])
      }
    })
    // El pronóstico arranca desde el último dato real para que la línea sea continua.
    if (firstFc > 0 && rows[firstFc - 1].real !== undefined) {
      const anchor: [number, number] = [x(firstFc - 1), y(rows[firstFc - 1].real!)]
      med.unshift(anchor)
      upper.unshift(anchor)
      lower.unshift(anchor)
    }
    const band = upper.length ? path([...upper, ...lower.reverse()]) + 'Z' : ''

    // ~6 etiquetas de fecha en el eje X
    const every = Math.max(1, Math.ceil(rows.length / Math.max(2, Math.floor(innerW / 110))))
    const xTicks = rows.map((_, i) => i).filter((i) => i % every === 0)

    return { innerW, innerH, ticks, x, y, hist: path(hist), med: path(med), band, firstFc, xTicks }
  }, [rows, width])

  const onMove = (e: React.PointerEvent<SVGRectElement>) => {
    const rect = e.currentTarget.getBoundingClientRect()
    const frac = (e.clientX - rect.left) / rect.width
    setHover(Math.round(frac * (rows.length - 1)))
  }

  const h = hover !== null ? rows[hover] : null
  const tipLeft = hover !== null ? geo.x(hover) : 0

  return (
    <div className="chart" ref={wrapRef}>
      <svg width={width} height={HEIGHT} role="img" aria-label="Ventas diarias reales y pronóstico con intervalo del 80 %">
        {geo.ticks.map((t) => (
          <g key={t}>
            <line className="grid" x1={M.left} x2={M.left + geo.innerW} y1={geo.y(t)} y2={geo.y(t)} />
            <text className="axis" x={M.left - 8} y={geo.y(t)} dy="0.32em" textAnchor="end">
              {fmt.format(t)}
            </text>
          </g>
        ))}
        {geo.xTicks.map((i) => (
          <text key={i} className="axis" x={geo.x(i)} y={HEIGHT - 10} textAnchor="middle">
            {fmtDate(rows[i].fecha)}
          </text>
        ))}

        {geo.firstFc > 0 && (
          <g>
            <line className="today" x1={geo.x(geo.firstFc - 1)} x2={geo.x(geo.firstFc - 1)} y1={M.top} y2={M.top + geo.innerH} />
            <text className="axis" x={geo.x(geo.firstFc - 1) + 6} y={M.top + 10}>
              Hoy
            </text>
          </g>
        )}

        <path className="band" d={geo.band} />
        <path className="line hist" d={geo.hist} />
        <path className="line fc" d={geo.med} />

        {h && hover !== null && (
          <g>
            <line className="crosshair" x1={tipLeft} x2={tipLeft} y1={M.top} y2={M.top + geo.innerH} />
            {h.real !== undefined && <circle className="dot hist" cx={tipLeft} cy={geo.y(h.real)} r={4} />}
            {h.mediana !== undefined && <circle className="dot fc" cx={tipLeft} cy={geo.y(h.mediana)} r={4} />}
          </g>
        )}

        <rect
          x={M.left}
          y={M.top}
          width={geo.innerW}
          height={geo.innerH}
          fill="transparent"
          onPointerMove={onMove}
          onPointerLeave={() => setHover(null)}
        />
      </svg>

      {h && hover !== null && (
        <div
          className="tooltip"
          style={{
            left: tipLeft,
            top: M.top,
            // A la derecha del cursor en la mitad izquierda; a la izquierda en la otra.
            transform: tipLeft > width / 2 ? 'translateX(calc(-100% - 12px))' : 'translateX(12px)',
          }}
        >
          <div className="tip-date">{fmtDate(h.fecha, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })}</div>
          {h.real !== undefined && (
            <div className="tip-row">
              <span className="swatch hist" /> Real <b>{fmt.format(h.real)}</b>
            </div>
          )}
          {h.mediana !== undefined && (
            <>
              <div className="tip-row">
                <span className="swatch fc" /> Pronóstico <b>{fmt.format(h.mediana)}</b>
              </div>
              <div className="tip-sub">
                80 %: {fmt.format(h.p10 ?? 0)} – {fmt.format(h.p90 ?? 0)}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  )
}
