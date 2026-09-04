# Sport 4 · Autódromo Víctor García

Juego de carreras 3D en el navegador, ambientado en el Autódromo Municipal
"Víctor García" de General Alvear (Mendoza) con autos de la categoría Sport 4
de las Categorías Tradicionales: prototipos de tierra con motor de 4 cilindros,
ruedas delanteras descubiertas y jaula antivuelco.

Hecho con React, TypeScript, Vite y Three.js. Sin modelos ni texturas
externas: la pista, los autos, el ambiente y el sonido del motor se generan
por código.

## Correrlo

```bash
npm install
npm run dev
```

Abrir la URL que muestra Vite (por defecto http://localhost:5173).

## Controles

| Acción            | Teclado                 | Celular             |
| ----------------- | ----------------------- | ------------------- |
| Acelerar          | ↑ o W                   | botón GAS           |
| Frenar            | ↓, S o Espacio          | botón FRENO         |
| Doblar            | ← → o A D               | botones ◀ ▶         |
| Volver a la pista | R                       | botón "A pista"     |

Al cruzar la meta hay una secuencia de llegada de 14 s (`FINISH_SECONDS`):
cámara lenta, cámara de TV al costado de la línea, placa "¡Bandera a
cuadros!" con el puesto, giro de honor con la cámara orbitando y el público
festejando; un toque o tecla la salta. El banderillero (`Flagman` en
`crowd.ts`) agita la bandera mientras van llegando los autos.

Si el auto se aleja más de 8,5 m del borde durante 2,5 s (cortando camino o
clavado contra el terraplén), vuelve solo a la pista, con aviso y cuenta en
el HUD (`updateFarOff` en `src/game/race.ts`).
| Cambiar cámara    | C (persecución / lejana / capot) | botón "Cámara" |

## Estructura

- `src/game/track.ts`: trazado (puntos de control suavizados con Catmull-Rom,
  escalados a 1400 m), búsqueda de punto más cercano, curvatura.
- `src/game/car.ts`: física arcade con derrape sobre tierra, conteo de
  vueltas y colisiones entre autos.
- `src/game/ai.ts`: pilotos rivales que siguen la línea central y regulan la
  velocidad según la curvatura que viene.
- `src/game/race.ts`: grilla, largada, clasificación y fin de carrera.
- `src/game/scene3d.ts`: escena Three.js (pista de tierra con borde
  deshilachado sobre las bermas, piedras, pasto seco, carteles de frenaje,
  cubiertas, alambrado, terraplén, torre, álamos, cordillera, autos, polvo,
  cámaras).
- `src/game/crowd.ts`: público. Figuras humanas instanciadas con siluetas
  torneadas, ropa con textura (remera, camiseta a rayas, campera), caras con
  ojos y boca, barba o anteojos de sol, pelo corto o largo, gorra o sombrero,
  mate con termo y celular; posturas variadas, caminan por el terraplén y
  salen corriendo si un auto se va contra ellos (`updateCrowd` en `scene3d.ts`).
- `src/game/audio.ts`: audio con Web Audio. El motor del jugador mezcla
  loops del motor real (`public/audio/engine/`, cortados de un onboard con
  `scripts/engine_loops.py`) según las rpm de una caja de 5 marchas simulada,
  con limitador, corte al cambiar, petardeo al levantar y saturación de
  escape; encima van tierra y piedras, derrape, viento y los tres rivales
  más cercanos con estéreo y Doppler.
- `src/App.tsx`: menú, HUD, minimapa y resultados.

## Pruebas automatizadas

Durante la carrera, `window.__sport4` expone `{ race, scene }` para
teletransportar autos o cambiar la cámara desde Playwright o la consola.

## Pendiente

- El trazado es una aproximación: falta ajustarlo al plano real del circuito.
- Modelos de auto y liveries basados en fotos reales de la categoría.

## Modelos 3D de autos reales

Los autos 29 y 1 se reemplazan por modelos generados a partir de fotos si
existen los archivos `public/models/car29.glb` y `public/models/car1.glb`
(GLB, con o sin compresión meshopt). Si faltan, se usa el auto procedural.
La orientación de cada modelo se ajusta en `src/game/models.ts` (`yaw`).

## Audio

- `public/audio/engine/eng_<Hz>_<on|off>.wav`: loops del motor real por
  frecuencia de encendido (rpm = Hz × 30), "a fondo" y "levantado". Se generan
  con `python3 scripts/engine_loops.py onboard.mp3` (numpy, scipy, soundfile),
  que también escribe `src/game/engineLoops.ts`. El onboard no está en el repo.
- `public/audio/menu.mp3`: música del menú. Arranca con la primera interacción
  y se apaga al tocar Largar.
- `public/audio/velocidad.mp3`: "Velocidad Pura". Suena bajita durante la
  previa (debajo del relato), se corta al largar y vuelve a pleno al cruzar
  la meta y en la pantalla de resultados.
- Todas las pistas están reconvertidas a 32 kHz y bitrate bajo (música 72-76
  kbps estéreo, voces 34-37 kbps mono) para que el HTML único entre en el
  límite de 16 MB del Artifact.
- `public/audio/relato.mp3`: relato de Lucio Aguirre que suena en la previa; la
  duración de la previa (`introDuration` en `race.ts`) sigue la del audio.
- `public/audio/largada.mp3`: continuación del relato en la largada; arranca con
  la cuenta regresiva ("tres" a los 0,25 s, "¡largaron!" a los 3,15 s).

## Imágenes reales (opcionales)

Si existen, el juego las usa en lugar de las versiones dibujadas por código:

- `public/img/lucio.jpg`: foto del relator, en la placa de la previa.
- `public/img/logo-alvear.png`: isologo de la Municipalidad de General Alvear, en los paneles del mangrullo.
- `public/img/logo-act.png`: logo de ACT, en el banner del mangrullo.
