import { useCallback, useEffect, useRef, useState } from 'react'
import './App.css'
import { Race, RIVALS, PLAYER_SPEC, type TowerRow, type Difficulty } from './game/race'
import { InputManager } from './game/input'
import { EngineAudio, TrackPlayer, audioSrc } from './game/audio'
import { drawMinimap } from './game/render'
import { Scene3D, imageSrc, type CameraMode } from './game/scene3d'
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
  countdown: string
  phase: string
  offTrack: boolean
  tower: TowerRow[]
  time: number
  introTotal: number
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

/** Grilla completa en orden de cajón, para las tarjetas de la previa. */
const GRID = [...RIVALS, PLAYER_SPEC]

/** Foto del relator: si el archivo no existe, se muestran las iniciales. */
function RelatorAvatar() {
  const [ok, setOk] = useState(true)
  return (
    <div className="avatar">
      {ok ? <img src={imageSrc('lucio.jpg')} alt="Lucio Aguirre" onError={() => setOk(false)} /> : 'LA'}
    </div>
  )
}

/**
 * Sobreimpresos de la previa: título del circuito, tarjetas de pilotos con
 * barrido de luz y la placa del relator. `t` es el tiempo de la previa.
 */
function IntroOverlay({ t, total, onSkip }: { t: number; total: number; onSkip: () => void }) {
  const titleEnd = 8
  const cardsStart = 22 // cuando la cámara llega a la primera fila
  const cardsEnd = total - 7
  const perDriver = (cardsEnd - cardsStart) / GRID.length
  const driverIdx = Math.floor((t - cardsStart) / perDriver)
  const driver = t >= cardsStart && driverIdx < GRID.length ? GRID[driverIdx] : null
  const driverT = t - cardsStart - driverIdx * perDriver
  const flight = t > titleEnd && t < cardsStart
  return (
    <div className="intro">
      <div className="flare a" />
      <div className="flare b" />
      {t < titleEnd && (
        <div className="intro-title" style={{ opacity: t < 0.6 ? t / 0.6 : t > titleEnd - 0.8 ? (titleEnd - t) / 0.8 : 1 }}>
          <p className="tag red">Categorías Tradicionales · Mendoza</p>
          <h1 className="sweep">Autódromo Víctor García</h1>
          <p className="tag black">General Alvear · Sport 4 · Final</p>
        </div>
      )}
      {driver && (
        <div key={driverIdx} className="driver-card" style={{ opacity: driverT < 0.3 ? driverT / 0.3 : driverT > perDriver - 0.3 ? (perDriver - driverT) / 0.3 : 1 }}>
          <div className="num">{driver.number}</div>
          <div className="txt">
            <h2>{driver.name}</h2>
            <p className="sub">
              <span className="bar" style={{ background: driver.color }} />
              Cajón {driverIdx + 1} · {driver.number === 1 ? 'Tu auto' : 'Sport 4'}
            </p>
          </div>
        </div>
      )}
      {flight && (
        <div className="lower-third">
          <p className="tag red">Última final de la jornada</p>
          <h2>Sport 4 · Categorías Tradicionales</h2>
        </div>
      )}
      <div className="relator">
        <RelatorAvatar />
        <div>
          <p className="tag red small">Relata</p>
          <b>Lucio Aguirre</b>
        </div>
      </div>
      <button className="skip" onClick={onSkip}>
        Saltar previa (Espacio)
      </button>
    </div>
  )
}

export default function App() {
  const [screen, setScreen] = useState<Screen>('menu')
  const [laps, setLaps] = useState(5)
  const [difficulty, setDifficulty] = useState<Difficulty>('facil')
  const inMenuRef = useRef(true)
  const [results, setResults] = useState<ResultRow[]>([])
  const [hud, setHud] = useState<HudState | null>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const menuCanvasRef = useRef<HTMLCanvasElement>(null)
  const minimapRef = useRef<HTMLCanvasElement>(null)
  const raceRef = useRef<Race | null>(null)
  const inputRef = useRef(new InputManager())
  const musicRef = useRef<TrackPlayer | null>(null)
  const skipRef = useRef<() => void>(() => {})
  const [musicOn, setMusicOn] = useState(false)

  // Música del menú: arranca con la primera interacción (los navegadores bloquean el autoplay).
  useEffect(() => {
    inMenuRef.current = screen === 'menu'
    if (screen !== 'menu') return
    if (!musicRef.current) musicRef.current = new TrackPlayer(audioSrc('menu'), true)
    const music = musicRef.current
    let done = false
    const tryPlay = () => {
      if (done) return
      music.play(0.7).then((ok) => {
        if (ok) {
          done = true
          setMusicOn(true)
          // Si el clic que arrancó la música fue "Largar", queda baja para la previa.
          music.fadeTo(inMenuRef.current ? 0.7 : 0.18, 1)
        }
      })
    }
    tryPlay()
    if (music.playing) music.fadeTo(0.7, 1.5)
    window.addEventListener('pointerdown', tryPlay)
    window.addEventListener('keydown', tryPlay)
    return () => {
      window.removeEventListener('pointerdown', tryPlay)
      window.removeEventListener('keydown', tryPlay)
    }
  }, [screen])

  // Fondo del menú: la escena en vivo con un paneo lento por la grilla.
  useEffect(() => {
    if (screen !== 'menu') return
    const canvas = menuCanvasRef.current
    if (!canvas) return
    const preview = new Race(1, '')
    const scene = new Scene3D(canvas, preview.track, preview.cars)
    let raf = 0
    let last = performance.now()
    const t0 = last
    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 1.5)
      scene.resize(window.innerWidth, window.innerHeight, dpr)
      canvas.style.width = `${window.innerWidth}px`
      canvas.style.height = `${window.innerHeight}px`
    }
    resize()
    window.addEventListener('resize', resize)
    const frame = (now: number) => {
      // El primer timestamp del rAF puede ser anterior al arranque (la escena tarda en construirse).
      const dt = Math.max(0, Math.min(0.1, (now - last) / 1000))
      last = now
      scene.renderMenu(preview.cars, Math.max(0, (now - t0) / 1000), dt)
      raf = requestAnimationFrame(frame)
    }
    raf = requestAnimationFrame(frame)
    return () => {
      cancelAnimationFrame(raf)
      window.removeEventListener('resize', resize)
      scene.dispose()
    }
  }, [screen])

  const startRace = useCallback(() => {
    raceRef.current = new Race(laps, '', difficulty)
    setResults([])
    inMenuRef.current = false
    setScreen('race')
    // La música baja durante la previa (relato) y se apaga al largar.
    musicRef.current?.fadeTo(0.18, 2)
  }, [laps, difficulty])

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
    const relato = new TrackPlayer(audioSrc('relato'), false)
    void relato.play(1)
    // Audio de la largada: continúa el relato y canta la cuenta "tres, dos, uno, ¡largaron!".
    const largada = new TrackPlayer(audioSrc('largada'), false)
    let musicMuted = false
    let largadaStarted = false
    const skipIntro = () => {
      race.skipIntro()
      relato.fadeTo(0, 0.8, true)
    }
    const onSkipKey = (e: KeyboardEvent) => {
      if ((e.key === ' ' || e.key === 'Enter') && race.phase === 'intro') skipIntro()
    }
    window.addEventListener('keydown', onSkipKey)
    skipRef.current = skipIntro

    let raf = 0
    let last = performance.now()
    const introStart = performance.now()
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
      // El primer timestamp del rAF puede ser anterior al arranque (la escena tarda en construirse).
      const dt = Math.max(0, Math.min(0.1, (now - last) / 1000))
      last = now
      acc += dt
      const controls = input.read()
      if (input.consumeReset()) race.resetPlayer()
      if (input.consumeCamera()) {
        scene.cameraMode = CAMERA_MODES[(CAMERA_MODES.indexOf(scene.cameraMode) + 1) % CAMERA_MODES.length]
      }
      if (race.phase === 'intro') {
        race.setIntroTime(Math.max(0, (now - introStart) / 1000))
        acc = 0
      }
      if (race.phase === 'intro') {
        // La previa corre con el reloj real para ir en sincronía con el relato.
        race.setIntroTime(Math.max(0, (now - introStart) / 1000))
        acc = 0
      }
      while (acc >= FIXED) {
        race.step(FIXED, controls)
        acc -= FIXED
      }
      if (race.phase === 'intro' && race.time >= race.introDuration) skipIntro()

      const p = race.player
      if (race.phase === 'intro') {
        scene.renderIntro(race.cars, p, race.time, race.introDuration, dt)
      } else {
        if (!musicMuted) {
          musicMuted = true
          musicRef.current?.fadeTo(0, 1.5, true)
          relato.fadeTo(0, 0.6, true)
        }
        if (!largadaStarted) {
          // Arranca junto con la cuenta regresiva: el "tres" se escucha a los 0,25 s.
          largadaStarted = true
          void largada.play(1)
        }
        scene.update(race.cars, p, dt)
      }
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
          countdown: race.countdownLabel(),
          phase: race.phase,
          offTrack: !p.onAsphalt,
          tower: race.tower(),
          time: race.time,
          introTotal: race.introDuration,
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
      window.removeEventListener('keydown', onSkipKey)
      input.detach()
      audio.stop()
      relato.dispose()
      largada.dispose()
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
        <canvas ref={menuCanvasRef} className="menu-bg" />
        <div className="menu-card">
          <p className="tag red">Categorías Tradicionales · Mendoza</p>
          <h1>Sport 4</h1>
          <h2>Autódromo Municipal Víctor García</h2>
          <p className="muted">General Alvear, Mendoza · circuito de tierra · {TRACK_LENGTH_M} m</p>
          <label>
            Dificultad
            <div className="laps">
              {(['facil', 'normal'] as Difficulty[]).map((d) => (
                <button key={d} className={d === difficulty ? 'active' : ''} onClick={() => setDifficulty(d)}>
                  {d === 'facil' ? 'Fácil' : 'Normal'}
                </button>
              ))}
            </div>
          </label>
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
          <p className="help music">{musicOn ? '♪ Velocidad Pura' : '♪ Tocá en cualquier lado para la música'}</p>
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
      <canvas ref={minimapRef} className="minimap" hidden={hud?.phase === 'intro'} />
      {hud && hud.phase === 'intro' && <IntroOverlay t={hud.time} total={hud.introTotal} onSkip={() => skipRef.current()} />}
      {hud && hud.phase !== 'intro' && (
        <>
          <div className="bug">
            <span className="live">EN VIVO</span>
            <span className="show">SPORT 4 · FINAL</span>
          </div>
          <div className="hud tv-times">
            <div>
              <small>Vuelta</small>
              <b>
                {hud.lap}
                <span>/{raceRef.current?.totalLaps}</span>
              </b>
            </div>
            <div>
              <small>Actual</small>
              <b>{formatTime(hud.lapTime)}</b>
            </div>
            <div>
              <small>Mejor</small>
              <b>{formatTime(hud.bestLap)}</b>
            </div>
          </div>
          {(hud.phase === 'racing' || hud.phase === 'finished') && (
            <div className="hud tower">
              <div className="head">
                <span>Pos</span>
                <span>Piloto</span>
                <span>Dif.</span>
              </div>
              {hud.tower.map((r) => (
                <div key={r.number} className={`row${r.isPlayer ? ' me' : ''}`}>
                  <span className="p">{r.pos}</span>
                  <span className="bar" style={{ background: r.color }} />
                  <span className="n">{r.short}</span>
                  <span className="g">{r.gap}</span>
                </div>
              ))}
            </div>
          )}
          <div className="hud speed">
            <b>{Math.round(hud.speed)}</b>
            <small>km/h</small>
            {hud.offTrack && <div className="warn">¡Afuera!</div>}
          </div>
          {hud.phase === 'countdown' && (
            <div className="countdown">{hud.countdown}</div>
          )}
          {hud.phase === 'racing' && hud.lapTime < 1.5 && hud.lap === 1 && <div className="countdown go">¡Largaron!</div>}
        </>
      )}
      <div className="touch" hidden={!hud || hud.phase === 'intro'}>
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
      <div className="topbar" hidden={!hud || hud.phase === 'intro'}>
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
