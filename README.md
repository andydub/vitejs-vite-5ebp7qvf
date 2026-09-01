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
| Cambiar cámara    | C (persecución / lejana / capot) | botón "Cámara" |

## Estructura

- `src/game/track.ts`: trazado (puntos de control suavizados con Catmull-Rom,
  escalados a 1400 m), búsqueda de punto más cercano, curvatura.
- `src/game/car.ts`: física arcade con derrape sobre tierra, conteo de
  vueltas y colisiones entre autos.
- `src/game/ai.ts`: pilotos rivales que siguen la línea central y regulan la
  velocidad según la curvatura que viene.
- `src/game/race.ts`: grilla, largada, clasificación y fin de carrera.
- `src/game/scene3d.ts`: escena Three.js (pista de tierra, cubiertas,
  alambrado, tribuna, torre, álamos, cordillera, autos, polvo, cámaras).
- `src/game/audio.ts`: motor sintetizado con Web Audio.
- `src/App.tsx`: menú, HUD, minimapa y resultados.

## Pendiente

- El trazado es una aproximación: falta ajustarlo al plano real del circuito.
- Modelos de auto y liveries basados en fotos reales de la categoría.

## Modelos 3D de autos reales

Los autos 29 y 1 se reemplazan por modelos generados a partir de fotos si
existen los archivos `public/models/car29.glb` y `public/models/car1.glb`
(GLB, con o sin compresión meshopt). Si faltan, se usa el auto procedural.
La orientación de cada modelo se ajusta en `src/game/models.ts` (`yaw`).
