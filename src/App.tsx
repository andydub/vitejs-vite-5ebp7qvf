import { useCallback, useEffect, useRef, useState } from 'react'
import './App.css'
import { Race } from './game/race'
import { InputManager } from './game/input'
import { EngineAudio } from './game/audio'
import { drawMinimap } from './game/render'
import { Scene3D, type CameraMode } from './game/scene3d'
import { TRACK_LENGTH_M } from './game/track'

const CAMERA_MODES: CameraMode[] = ['chase', 'far', 'hood']

function formatTime(t: number): string {
  if (!isFinite(t)) return '--:--.---'
  const m = Math.floor(t / 60)
  const s = t - m * 60
  return `${m}:${s.toFixed(3).padStart(6, '0')}`
}

interface HudState {
  speed: number
  lap: number
  position: number
  total: number
  lapTime: number
  bestLap: number
  countdown: number
  phase: string
  offTrack: boolean
}

interface ResultRow {
  pos: number
  name: string
  number: number
  color: string
  bestLap: number
  gap: string
  isPlayer: boolean
}

type Screen = 'menu' | 'race' | 'results'

export default function App() {
  const [screen, setScreen] = useState<Screen>('menu')
  const [laps, setLaps] = useState(5)
  const [results, setResults] = useState<ResultRow[]>([])
  const [hud, setHud] = useState<HudState | null>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const minimapRef = useRef<HTMLCanvasElement>(null)
  const raceRef = useRef<Race | null>(null)
  const inputRef = useRef(new InputManager())

  const startRace = useCallback(() => {
    raceRef.current = new Race(laps, 'Vos')
    setResults([])
    setScreen('race')
  }, [laps])

  useEffect(() => {
    if (screen !== 'race') return
    const canvas = canvasRef.current
    const minimap = minimapRef.current
    const race = raceRef.current
    if (!canvas || !minimap || !race) return
    const scene = new Scene3D(canvas, race.track, race.cars)
    const mmCtx = minimap.getContext('2d')!
    const input = inputRef.current
    input.attach()
    const audio = new EngineAudio()
    audio.start()

    let raf = 0
    let last = performance.now()
    let acc = 0
    let hudTimer = 0
    const FIXED = 1 / 120

    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2)
      scene.resize(window.innerWidth, window.innerHeight, dpr)
      canvas.style.width = `${window.innerWidth}px`
      canvas.style.height = `${window.innerHeight}px`
      const mm = Math.min(180, window.innerWidth * 0.3)
      minimap.width = Math.floor((mm + 12) * dpr)
      minimap.height = Math.floor((mm + 12) * dpr)
      minimap.style.width = `${mm + 12}px`
      minimap.style.height = `${mm + 12}px`
    }
    resize()
    window.addEventListener('resize', resize)

    const frame = (now: number) => {
      const dt = Math.min(0.1, (now - last) / 1000)
      last = now
      acc += dt
      const controls = input.read()
      if (input.consumeReset()) race.resetPlayer()
      if (input.consumeCamera()) {
        scene.cameraMode = CAMERA_MODES[(CAMERA_MODES.indexOf(scene.cameraMode) + 1) % CAMERA_MODES.length]
      }
      while (acc >= FIXED) {
        race.step(FIXED, controls)
        acc -= FIXED
      }

      const p = race.player
      scene.update(race.cars, p, dt)
      audio.update(p.speed, race.phase === 'racing' ? controls.throttle : 0, dt)

      const dpr = Math.min(window.devicePixelRatio || 1, 2)
      mmCtx.setTransform(dpr, 0, 0, dpr, 0, 0)
      mmCtx.clearRect(0, 0, minimap.width, minimap.height)
      const mm = Math.min(180, window.innerWidth * 0.3)
      drawMinimap(mmCtx, race.track, race.cars, 6, 6, mm)

      hudTimer += dt
      if (hudTimer > 0.05) {
        hudTimer = 0
        setHud({
          speed: p.speedKmh,
          lap: Math.min(p.lap, race.totalLaps),
          position: race.positionOf(p),
          total: race.cars.length,
          lapTime: race.phase === 'countdown' ? 0 : race.time - p.lapStartTime,
          bestLap: p.bestLap,
          countdown: race.countdown,
          phase: race.phase,
          offTrack: !p.onAsphalt,
        })
      }

      if (race.phase === 'finished') {
        const st = race.standings()
        const winnerTime = st[0].finishTime
        setResults(
          st.map((c, i) => ({
            pos: i + 1,
            name: c.name,
            number: c.number,
            color: c.color,
            bestLap: c.bestLap,
            gap: i === 0 ? formatTime(c.finishTime) : c.finished ? `+${(c.finishTime - winnerTime).toFixed(3)}` : `+${Math.max(1, Math.round((st[0].progress - c.progress) / race.track.length))} vta`,
            isPlayer: c.isPlayer,
          })),
        )
        setScreen('results')
        return
      }
      raf = requestAnimationFrame(frame)
    }
    raf = requestAnimationFrame(frame)

    return () => {
      cancelAnimationFrame(raf)
      window.removeEventListener('resize', resize)
      input.detach()
      audio.stop()
      scene.dispose()
    }
  }, [screen])

  const touch = inputRef.current.touch
  const bind = (key: keyof typeof touch) => ({
    onPointerDown: (e: React.PointerEvent) => {
      e.preventDefault()
      touch[key] = true
    },
    onPointerUp: () => {
      touch[key] = false
    },
    onPointerLeave: () => {
      touch[key] = false
    },
    onPointerCancel: () => {
      touch[key] = false
    },
  })

  if (screen === 'menu') {
    return (
      <div className="menu">
        <div className="menu-card">
          <p className="eyebrow">Categorías Tradicionales · Mendoza</p>
          <h1>Sport 4</h1>
          <h2>Autódromo Municipal Víctor García</h2>
          <p className="muted">General Alvear, Mendoza · circuito de tierra · {TRACK_LENGTH_M} m · trazado aproximado</p>
          <label>
            Vueltas
            <div className="laps">
              {[3, 5, 8, 12].map((n) => (
                <button key={n} className={n === laps ? 'active' : ''} onClick={() => setLaps(n)}>
                  {n}
                </button>
              ))}
            </div>
          </label>
          <button className="primary" onClick={startRace}>
            Largar
          </button>
          <p className="help">
            Flechas o WASD para manejar · Espacio o ↓ frena · R te devuelve a la pista · C cambia la cámara. En celular
            usá los botones en pantalla.
          </p>
        </div>
      </div>
    )
  }

  if (screen === 'results') {
    return (
      <div className="menu">
        <div className="menu-card results">
          <p className="eyebrow">Resultado final</p>
          <h1>{results[0]?.isPlayer ? '¡Ganaste!' : `Terminaste ${results.find((r) => r.isPlayer)?.pos}°`}</h1>
          <table>
            <thead>
              <tr>
                <th>Pos</th>
                <th>N°</th>
                <th>Piloto</th>
                <th>Mejor vuelta</th>
                <th>Tiempo / dif.</th>
              </tr>
            </thead>
            <tbody>
              {results.map((r) => (
                <tr key={r.number} className={r.isPlayer ? 'me' : ''}>
                  <td>{r.pos}</td>
                  <td>
                    <span className="swatch" style={{ background: r.color }} />
                    {r.number}
                  </td>
                  <td>{r.name}</td>
                  <td>{formatTime(r.bestLap)}</td>
                  <td>{r.gap}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="row">
            <button className="primary" onClick={startRace}>
              Correr de nuevo
            </button>
            <button onClick={() => setScreen('menu')}>Menú</button>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="game">
      <canvas ref={canvasRef} />
      <canvas ref={minimapRef} className="minimap" />
      {hud && (
        <>
          <div className="hud top-left">
            <div className="pos">
              P{hud.position}
              <span>/{hud.total}</span>
            </div>
            <div className="lap">
              Vuelta {hud.lap}
              <span>/{raceRef.current?.totalLaps}</span>
            </div>
            <div className="times">
              <div>
                Actual <b>{formatTime(hud.lapTime)}</b>
              </div>
              <div>
                Mejor <b>{formatTime(hud.bestLap)}</b>
              </div>
            </div>
          </div>
          <div className="hud speed">
            <b>{Math.round(hud.speed)}</b> km/h
            {hud.offTrack && <div className="warn">¡Afuera!</div>}
          </div>
          {hud.phase === 'countdown' && (
            <div className="countdown">{hud.countdown > 3 ? '' : Math.ceil(hud.countdown) || '¡Largaron!'}</div>
          )}
          {hud.phase === 'racing' && hud.lapTime < 1.5 && hud.lap === 1 && <div className="countdown go">¡Largaron!</div>}
        </>
      )}
      <div className="touch">
        <div className="group">
          <button {...bind('left')}>◀</button>
          <button {...bind('right')}>▶</button>
        </div>
        <div className="group">
          <button className="brake" {...bind('brake')}>
            FRENO
          </button>
          <button className="gas" {...bind('gas')}>
            GAS
          </button>
        </div>
      </div>
      <div className="topbar">
        <button className="quit" onClick={() => (inputRef.current.touch.reset = true)}>
          A pista (R)
        </button>
        <button className="quit" onClick={() => inputRef.current.pressCamera()}>
          Cámara (C)
        </button>
        <button className="quit" onClick={() => setScreen('menu')}>
          Abandonar
        </button>
      </div>
    </div>
  )
}
