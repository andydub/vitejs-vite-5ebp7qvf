"""API de pronóstico de ventas con TimesFM.

Ejecutar:  uvicorn main:app --reload --port 8000
"""

from __future__ import annotations

import logging
from functools import lru_cache

import numpy as np
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field

from forecaster import MAX_HORIZON, backtest, load_forecaster
from sample_data import sample_sales

logging.basicConfig(level=logging.INFO)

app = FastAPI(title="Pronóstico de ventas · TimesFM")


@lru_cache(maxsize=1)
def get_forecaster():
  return load_forecaster()


class ForecastRequest(BaseModel):
  values: list[float] = Field(min_length=14, description="Serie histórica en orden cronológico")
  horizon: int = Field(ge=1, le=MAX_HORIZON)
  backtest: bool = True


@app.get("/api/health")
def health():
  f = get_forecaster()
  return {"ok": True, "backend": f.name, "label": f.label}


@app.get("/api/sample")
def sample():
  return {"rows": sample_sales()}


@app.post("/api/forecast")
def forecast(req: ForecastRequest):
  values = np.asarray(req.values, dtype=float)
  if not np.all(np.isfinite(values)):
    raise HTTPException(422, "La serie contiene valores no numéricos o vacíos.")
  f = get_forecaster()
  fc = f.forecast(values, req.horizon)
  return {
    "backend": f.name,
    "label": f.label,
    "point": fc.point.tolist(),
    "quantiles": {f"p{q}": v.tolist() for q, v in fc.quantiles.items()},
    "backtest": backtest(f, values, req.horizon) if req.backtest else None,
  }
