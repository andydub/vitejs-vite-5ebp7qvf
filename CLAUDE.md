# Sport 4 Alvear — notas para continuar el trabajo

Juego de carreras 3D en el navegador: categoría **Sport 4** (Categorías
Tradicionales de Mendoza) en el **Autódromo Municipal "Víctor García"** de
General Alvear, circuito de tierra de 1400 m. El usuario habla español
(Argentina): responder en español, tono cercano.

## Dónde está todo

- Rama de trabajo: `claude/racing-game-alvear-nzrosq` (desarrollar y pushear ahí).
- Publicado como Artifact en
  https://claude.ai/code/artifact/73110495-a303-4f99-9cce-1a502819f7e1 —
  republicar SIEMPRE en esa URL (pasar `url`), nunca crear otro artifact.
  Si el publish se rechaza por "versión más nueva", hacer primero
  `Artifact action:"read"` de esa URL y volver a publicar.
- El link compartido para el celular del usuario está clavado en una versión
  vieja: él tiene que mover el pin desde el menú de compartir.
- `README.md` describe la estructura del código, controles y assets.

## Flujo para entregar un cambio

```bash
npx tsc -b && npm run lint
rm -rf dist && npm run build
python3 scripts/bundle.py /ruta/sport4-alvear.html   # HTML único con todo embebido (~14 MB)
git add -A && git commit && git push -u origin claude/racing-game-alvear-nzrosq
# luego Artifact publish con file_path=ese HTML y url=la del artifact
```

## Decisiones ya tomadas (no volver a preguntar)

- Jugador: Bruno del Pozo, #1 (modelo `car1`), larga último. Schiavone es
  sponsor, no piloto. Grilla y orden en `RIVALS` (`src/game/race.ts`).
- Dos modelos GLB reales (`car29`, `car1`) reteñidos por equipo; ruedas
  procedurales (`src/game/wheel.ts`), no las del modelo.
- Trazado calcado del plano del usuario (`SAT_POINTS` en `src/game/track.ts`).
  El lado exterior sale de la orientación del lazo (`outwardAt`), no del
  centro: alambrado, terraplén, público y paddock van siempre afuera.
- Previa de 59 s con el relato de Lucio Aguirre (`public/audio/relato.mp3`),
  cámara con reloj real; al terminar suena `largada.mp3` y la cuenta 3-2-1
  sigue `COUNTDOWN_CUES` (largan a los 3,15 s del audio).
- Música del menú `menu.mp3`: sube con el primer clic, baja a 0,18 al tocar
  Largar y se corta al largar.
- Gráfica estilo ESPN (Barlow Condensed, paneles rojos/negros inclinados),
  torre de tiempos estilo F1 con histéresis de 2 s y refresco 1 Hz.
- Dificultad Fácil (por defecto) / Normal; rivales con ritmo variable
  (`updatePace` en `race.ts`), Pashkowec es el rezagado.
- Logos reales de la Municipalidad y ACT (`public/img/`) sobre los carteles
  dibujados; foto de Lucio en la placa del relator.
- Borde de pista: la textura de la pista sobresale `TRACK_OVERHANG` m sobre
  las bermas y se recorta con alfa (`alphaTest`) para que la tierra
  compactada se deshaga en lenguas y terrones; `BERM_PROFILE` (track.ts) es
  la única fuente del perfil de la berma. Piedras, pastos secos y carteles de
  100/50 m en `buildTrackDressing`.
- Audio del motor: loops reales del onboard del usuario (Tiago Carreras,
  Sport 4) en `public/audio/engine/`, generados con
  `scripts/engine_loops.py onboard.mp3` (el mp3 no está en el repo; pedirlo
  si hay que regenerar). Caja de 5 marchas, limitador, petardeo, tierra,
  derrape, viento y rivales con Doppler en `src/game/audio.ts`. El bundle
  embebe los WAV con clave `engine/<archivo>` en `__SPORT4_AUDIO`.
  Para probar sin escuchar: `window.__sport4.audio` expone `rpm`, `gear`,
  `ready` y `level` (RMS de salida).
- Anti-atajo: `updateFarOff` en race.ts devuelve al jugador a la pista si
  pasa `FAR_OFF_SECONDS` (2,5 s) a más de `FAR_OFF_METERS` (8,5 m) del borde;
  el HUD muestra "¡Volvé a pista! N".
- Público en `src/game/crowd.ts` (siluetas torneadas, texturas de ropa y
  cara en blanco y grises teñidas por el color de instancia, variantes por
  InstancedMesh: 3 remeras, 3 caras, gorra/sombrero, mate/termo/celular). La huida ante un auto que se sale está en `updateCrowd`
  (scene3d.ts): huyen hacia los costados de la trayectoria, esperan y
  vuelven caminando. Los de arriba del camión son `fixed`.

## Cómo probar sin GPU

- Simulación sin navegador: compilar `src/game/{race,car,ai,track,input,models}.ts`
  con `tsc` a un directorio con `package.json {"type":"module"}`, reemplazar
  `import.meta.env.BASE_URL` por `'/'` y agregar `.js` a los imports; luego
  `race.skipIntro()` y `race.step(1/120, controls)` en bucle.
- Capturas: `npx vite preview --port 4173` + Playwright con Chromium en
  `--use-angle=swiftshader`. Cada frame tarda ~2 s; usar viewport chico
  (640×360) y esperas largas. Abortar `fonts.googleapis.com` en las pruebas.
  Playwright global está en `/opt/node22/lib/node_modules/playwright`.
  Al clic en "Largar" usar `{ noWaitAfter: true }` (la escena tarda en
  construirse). En carrera, `window.__sport4 = { race, scene }` permite
  teletransportar al jugador (`race.player.x/y/heading/speed`), cambiar
  `scene.cameraMode` y leer `scene.fleeingCount`. El cartel "¡Largaron!"
  tapa la pantalla hasta ~5 s después de `race.player.lapStartTime`.
- En el Artifact publicado no funciona `fetch` sobre URLs `data:` (política
  de seguridad): los assets embebidos en `__SPORT4_*` se decodifican del
  base64 a mano (ver `loadLoops` en audio.ts). Para reproducirlo en pruebas,
  anular `window.fetch` con `page.addInitScript`.
- El ffmpeg de Playwright no decodifica mp3: usar `soundfile` (pip) para
  análisis de audio. YouTube está bloqueado por la red: pedir el archivo.
- Las imágenes pegadas en el chat no llegan como archivo: pedir que las suba
  como adjunto o al repo (`public/`).

## Ideas pendientes que el usuario mencionó

- Soporte de joystick/gamepad (para PC y para el navegador de PS5).
- Empaquetar como programa de escritorio (Electron/Tauri) si lo pide.
