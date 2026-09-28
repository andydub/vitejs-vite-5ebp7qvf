import { useEffect, useMemo, useState } from 'react'
import { SalesChart, type ChartRow } from './SalesChart'
import {
  addDays,
  fmt,
  fmtDate,
  fmtPct,
  parseCsv,
  sum,
  type ForecastResponse,
  type Point,
} from './data'

const HORIZONS = [7, 14, 30, 60, 90]

export default function App() {
  const [series, setSeries] = useState<Point[]>([])
  const [source, setSource] = useState('')
  const [horizon, setHorizon] = useState(30)
  const [result, setResult] = useState<ForecastResponse | null>(null)
  const [engine, setEngine] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [showTable, setShowTable] = useState(false)

  useEffect(() => {
    fetch('/api/health')
      .then((r) => r.json())
      .then((h) => setEngine(h.label))
      .catch(() => setEngine(null))
  }, [])

  const loadSample = async () => {
    setError(null)
    try {
      const r = await fetch('/api/sample')
      const { rows } = await r.json()
      setSeries(rows)
      setSource('Datos de ejemplo (2 años de ventas diarias)')
      setResult(null)
    } catch {
      setError('No se pudo conectar con el servidor. ¿Está corriendo en el puerto 8000?')
    }
  }

  const loadFile = async (file: File) => {
    setError(null)
    try {
      const rows = parseCsv(await file.text())
      if (rows.length < 14) throw new Error('Hacen falta al menos 14 días de datos.')
      setSeries(rows)
      setSource(`${file.name} · ${rows.length} días`)
      setResult(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  const runForecast = async () => {
    setLoading(true)
    setError(null)
    try {
      const r = await fetch('/api/forecast', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ values: series.map((p) => p.ventas), horizon }),
      })
      if (!r.ok) throw new Error((await r.json()).detail ?? r.statusText)
      setResult(await r.json())
    } catch (e) {
      setError(`Error al pronosticar: ${e instanceof Error ? e.message : e}`)
    } finally {
      setLoading(false)
    }
  }

  const lastDate = series.at(-1)?.fecha
  const fcRows = useMemo(() => {
    if (!result || !lastDate) return []
    return result.point.map((v, i) => ({
      fecha: addDays(lastDate, i + 1),
      mediana: v,
      p10: result.quantiles.p10[i],
      p90: result.quantiles.p90[i],
    }))
  }, [result, lastDate])

  const chartRows: ChartRow[] = useMemo(() => {
    const visible = Math.min(series.length, Math.max(90, horizon * 3))
    const hist = series.slice(-visible).map((p) => ({ fecha: p.fecha, real: p.ventas }))
    return [...hist, ...fcRows]
  }, [series, fcRows, horizon])

  const kpis = useMemo(() => {
    if (!result) return null
    const total = sum(result.point)
    const prev = sum(series.slice(-result.point.length).map((p) => p.ventas))
    return {
      total,
      change: prev > 0 ? ((total - prev) / prev) * 100 : null,
      low: sum(result.quantiles.p10),
      high: sum(result.quantiles.p90),
      mape: result.backtest?.mape ?? null,
    }
  }, [result, series])

  const downloadCsv = () => {
    const lines = ['fecha,p10,mediana,p90', ...fcRows.map((r) => [r.fecha, r.p10, r.mediana, r.p90].map((v) => (typeof v === 'number' ? v.toFixed(2) : v)).join(','))]
    const url = URL.createObjectURL(new Blob([lines.join('\n')], { type: 'text/csv' }))
    const a = Object.assign(document.createElement('a'), { href: url, download: 'pronostico_ventas.csv' })
    a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <main>
      <header>
        <div>
          <h1>Pronóstico de ventas</h1>
          <p className="muted">Sube tus ventas diarias y obtén la previsión con su rango de incertidumbre.</p>
        </div>
        <span className={`badge ${engine ? '' : 'off'}`} title="Motor de pronóstico del servidor">
          {engine ?? 'Servidor desconectado'}
        </span>
      </header>

      <section className="controls">
        <label className="btn">
          Cargar CSV
          <input
            type="file"
            accept=".csv,text/csv"
            hidden
            onChange={(e) => e.target.files?.[0] && loadFile(e.target.files[0])}
          />
        </label>
        <button className="btn" onClick={loadSample}>
          Usar datos de ejemplo
        </button>
        <label className="field">
          Horizonte
          <select value={horizon} onChange={(e) => setHorizon(+e.target.value)}>
            {HORIZONS.map((h) => (
              <option key={h} value={h}>
                {h} días
              </option>
            ))}
          </select>
        </label>
        <button className="btn primary" disabled={series.length < 14 || loading} onClick={runForecast}>
          {loading ? 'Calculando…' : 'Pronosticar'}
        </button>
      </section>

      {error && <p className="error" role="alert">{error}</p>}

      {series.length === 0 ? (
        <section className="empty">
          <p>
            Carga un CSV con una columna de <b>fecha</b> y otra de <b>ventas</b> (una fila por día o por ticket; se
            suman por día), o prueba con los datos de ejemplo.
          </p>
          <pre>fecha,ventas{'\n'}2025-01-01,1520{'\n'}2025-01-02,1310{'\n'}…</pre>
        </section>
      ) : (
        <>
          <p className="muted source">
            {source} · del {fmtDate(series[0].fecha, { day: 'numeric', month: 'short', year: 'numeric' })} al{' '}
            {fmtDate(lastDate!, { day: 'numeric', month: 'short', year: 'numeric' })}
          </p>

          {kpis && (
            <section className="kpis">
              <div className="kpi">
                <span className="kpi-label">Ventas previstas ({horizon} días)</span>
                <span className="kpi-value">{fmt.format(kpis.total)}</span>
                {kpis.change !== null && (
                  <span className="kpi-sub">{fmtPct.format(kpis.change)} % vs. los últimos {horizon} días</span>
                )}
              </div>
              <div className="kpi">
                <span className="kpi-label">Rango probable</span>
                <span className="kpi-value small">
                  {fmt.format(kpis.low)} – {fmt.format(kpis.high)}
                </span>
                <span className="kpi-sub">suma de percentiles 10 y 90 (orientativo)</span>
              </div>
              <div className="kpi">
                <span className="kpi-label">Error en prueba histórica</span>
                <span className="kpi-value">{kpis.mape !== null ? `${kpis.mape.toFixed(1)} %` : '—'}</span>
                <span className="kpi-sub">MAPE pronosticando los últimos {horizon} días ya conocidos</span>
              </div>
            </section>
          )}

          <section className="card">
            <div className="card-head">
              <h2>Ventas diarias</h2>
              <div className="legend">
                <span><span className="swatch hist" /> Real</span>
                {result && (
                  <>
                    <span><span className="swatch fc" /> Pronóstico (mediana)</span>
                    <span><span className="swatch band" /> Intervalo 80 %</span>
                  </>
                )}
              </div>
            </div>
            <SalesChart rows={chartRows} />
            {result && (
              <div className="card-foot">
                <button className="link" onClick={() => setShowTable((s) => !s)}>
                  {showTable ? 'Ocultar tabla' : 'Ver tabla'}
                </button>
                <button className="link" onClick={downloadCsv}>
                  Descargar CSV
                </button>
                <span className="muted">Motor: {result.label}</span>
              </div>
            )}
            {result && showTable && (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Fecha</th>
                      <th>Mínimo probable (p10)</th>
                      <th>Mediana</th>
                      <th>Máximo probable (p90)</th>
                    </tr>
                  </thead>
                  <tbody>
                    {fcRows.map((r) => (
                      <tr key={r.fecha}>
                        <td>{fmtDate(r.fecha, { weekday: 'short', day: 'numeric', month: 'short' })}</td>
                        <td>{fmt.format(r.p10)}</td>
                        <td><b>{fmt.format(r.mediana)}</b></td>
                        <td>{fmt.format(r.p90)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </>
      )}
    </main>
  )
}
