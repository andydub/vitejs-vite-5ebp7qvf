# Pronóstico de ventas con TimesFM

Dashboard para prever ventas diarias con
[TimesFM](https://github.com/google-research/timesfm), el modelo fundacional de
series temporales de Google Research. Subes un CSV con tus ventas y obtienes la
previsión para los próximos 7–90 días con un intervalo de confianza del 80 %.

```
ventas-timesfm/
├── server/   API en Python (FastAPI) que ejecuta TimesFM
└── web/      Frontend en React + TypeScript (Vite)
```

## Qué hace

- **Carga de datos**: CSV con una columna de fecha y otra de importe. Admite
  `,` `;` o tabulador, fechas `2026-01-31` o `31/01/2026` y números `1.234,50`.
  Si hay varias filas por día (una por ticket o por tienda), las suma. Los días
  sin filas cuentan como 0 ventas.
- **Pronóstico**: mediana y percentiles 10–90 para cada día futuro.
- **KPIs**: total previsto, variación frente a los últimos N días, rango probable
  y **error en prueba histórica** (MAPE). Para medirlo se pronostican los últimos
  N días ya conocidos y se comparan con lo que ocurrió de verdad.
- **Gráfico interactivo** (tooltip al pasar el ratón), tabla y descarga del
  pronóstico en CSV. Tiene modo claro/oscuro y funciona en móvil.

## Modelo

Se usa **TimesFM 2.5 (200M parámetros)**, checkpoint
`google/timesfm-2.5-200m-pytorch`, con licencia **Apache-2.0**, así que se puede
usar comercialmente. (Los pesos de TimesFM 3.0 tienen licencia no comercial,
por eso no se usan aquí.)

Si `timesfm` no está instalado, el servidor usa un **baseline estacional**
(repite la última semana con tendencia) para que la app funcione igual. El
motor activo se ve arriba a la derecha. Se puede forzar con la variable
`FORECAST_BACKEND=timesfm|baseline` (por defecto `auto`).

## Puesta en marcha

Requisitos: Python ≥ 3.10 y Node ≥ 20. La primera vez, TimesFM descarga ~800 MB
de pesos desde Hugging Face.

```bash
# 1) Backend
cd ventas-timesfm/server
python -m venv .venv && source .venv/bin/activate
pip install torch --index-url https://download.pytorch.org/whl/cpu   # o la versión con CUDA
pip install -r requirements.txt
uvicorn main:app --port 8000

# 2) Frontend (otra terminal)
cd ventas-timesfm/web
npm install
npm run dev        # http://localhost:5173  (reenvía /api al puerto 8000)
```

Tests del backend: `cd server && FORECAST_BACKEND=baseline pytest`.

## API

| Método | Ruta            | Descripción                                             |
| ------ | --------------- | ------------------------------------------------------- |
| GET    | `/api/health`   | Motor activo (`timesfm-2.5` o `baseline`)               |
| GET    | `/api/sample`   | 2 años de ventas diarias sintéticas                     |
| POST   | `/api/forecast` | `{ "values": number[], "horizon": 1–256 }` → pronóstico |

## Siguientes pasos posibles

- Covariables (promociones, festivos, precio) con `forecast_with_covariates` de
  TimesFM (XReg).
- Varias series a la vez (por tienda o producto) en una sola llamada batch.
- Frecuencia semanal/mensual además de diaria.
