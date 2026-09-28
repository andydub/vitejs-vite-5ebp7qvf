export type Point = { fecha: string; ventas: number }

export type ForecastResponse = {
  backend: string
  label: string
  point: number[]
  quantiles: Record<string, number[]>
  backtest: { mape: number | null; mae: number; coverage80: number; point: number[] } | null
}

const DAY = 86_400_000
const VALUE_HEADER = /venta|importe|total|factura|ingreso|sales|revenue|amount/i

export function toISO(d: Date): string {
  return d.toISOString().slice(0, 10)
}

export function addDays(iso: string, n: number): string {
  return toISO(new Date(Date.parse(iso) + n * DAY))
}

/** Acepta 2024-03-31, 31/03/2024 y 31-03-2024. Devuelve YYYY-MM-DD o null. */
function parseDate(raw: string): string | null {
  const s = raw.trim().replace(/^"|"$/g, '')
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/)
  if (m) return iso(+m[1], +m[2], +m[3])
  m = s.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/)
  if (m) return iso(+m[3], +m[2], +m[1])
  return null
}

function iso(y: number, mo: number, d: number): string | null {
  const date = new Date(Date.UTC(y, mo - 1, d))
  return date.getUTCMonth() === mo - 1 ? toISO(date) : null
}

/** Acepta 1234.5, 1.234,5 y 1234,5. */
function parseNumber(raw: string): number | null {
  let s = raw.trim().replace(/^"|"$/g, '').replace(/[€$\s]/g, '')
  if (s === '') return null
  if (/,\d{1,2}$/.test(s)) s = s.replace(/\./g, '').replace(',', '.')
  else s = s.replace(/,/g, '')
  const n = Number(s)
  return Number.isFinite(n) ? n : null
}

/**
 * Lee un CSV con una columna de fecha y otra de importe. Si hay varias filas
 * por día (p. ej. una por ticket) se suman; los días sin ventas cuentan como 0.
 */
export function parseCsv(text: string): Point[] {
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== '')
  if (lines.length < 2) throw new Error('El CSV está vacío.')
  const delim = [';', ',', '\t'].reduce((best, d) =>
    lines[0].split(d).length > lines[0].split(best).length ? d : best,
  )
  const rows = lines.map((l) => l.split(delim))
  const body = parseDate(rows[0][0] ?? '') ? rows : rows.slice(1)
  const sample = body[0] ?? []

  const dateCol = sample.findIndex((c) => parseDate(c) !== null)
  const isValue = (c: string, i: number) => i !== dateCol && parseNumber(c) !== null
  // Si la cabecera nombra la columna de importe, se prefiere a la primera numérica.
  const named = body === rows ? -1 : rows[0].findIndex((h, i) => VALUE_HEADER.test(h) && isValue(sample[i] ?? '', i))
  const valueCol = named >= 0 ? named : sample.findIndex(isValue)
  if (dateCol < 0 || valueCol < 0) {
    throw new Error('No encuentro una columna de fecha y otra numérica.')
  }

  const totals = new Map<string, number>()
  for (const r of body) {
    const d = parseDate(r[dateCol] ?? '')
    const v = parseNumber(r[valueCol] ?? '')
    if (d && v !== null) totals.set(d, (totals.get(d) ?? 0) + v)
  }
  return fillDays(totals)
}

function fillDays(totals: Map<string, number>): Point[] {
  const days = [...totals.keys()].sort()
  if (days.length === 0) throw new Error('No hay filas válidas.')
  const out: Point[] = []
  for (let d = days[0]; d <= days[days.length - 1]; d = addDays(d, 1)) {
    out.push({ fecha: d, ventas: totals.get(d) ?? 0 })
  }
  return out
}

export function sum(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0)
}

export const fmt = new Intl.NumberFormat('es-ES', { maximumFractionDigits: 0 })
export const fmtPct = new Intl.NumberFormat('es-ES', {
  maximumFractionDigits: 1,
  signDisplay: 'exceptZero',
})

export function fmtDate(isoDate: string, opts: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'short' }) {
  return new Date(isoDate + 'T00:00:00Z').toLocaleDateString('es-ES', { ...opts, timeZone: 'UTC' })
}
