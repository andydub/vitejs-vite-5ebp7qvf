"""Motores de pronóstico: TimesFM 2.5 (si está instalado) o un baseline estacional.

TimesFM 2.5 (google/timesfm-2.5-200m-pytorch) se distribuye con licencia
Apache-2.0, así que se puede usar comercialmente. Si `timesfm` o `torch` no
están instalados, o si FORECAST_BACKEND=baseline, se usa un modelo estacional
ingenuo para que la app funcione igualmente (útil para desarrollo).
"""

from __future__ import annotations

import logging
import os
import threading
from dataclasses import dataclass

import numpy as np

log = logging.getLogger(__name__)

# Percentiles que devolvemos al frontend.
QUANTILES = (10, 20, 30, 40, 50, 60, 70, 80, 90)

MAX_CONTEXT = 1024
MAX_HORIZON = 256
TIMESFM_CHECKPOINT = "google/timesfm-2.5-200m-pytorch"


@dataclass
class Forecast:
  point: np.ndarray  # (horizon,) mediana
  quantiles: dict[int, np.ndarray]  # percentil -> (horizon,)


class BaselineForecaster:
  """Estacional ingenuo con deriva; intervalos a partir de los residuos."""

  name = "baseline"
  label = "Baseline estacional (sin TimesFM)"

  def __init__(self, season: int = 7):
    self.season = season

  def forecast(self, values: np.ndarray, horizon: int) -> Forecast:
    y = np.asarray(values, dtype=float)
    m = self.season if len(y) >= 2 * self.season else 1
    last_season = y[-m:]
    reps = int(np.ceil(horizon / m))
    point = np.tile(last_season, reps)[:horizon]

    # Deriva: diferencia media entre temporadas consecutivas.
    if len(y) >= 2 * m:
      drift = np.mean(y[m:] - y[:-m]) / m
      point = point + drift * np.arange(1, horizon + 1)

    resid = (y[m:] - y[:-m]) if len(y) > m else np.zeros(1)
    resid = resid - resid.mean()
    # La incertidumbre crece con el número de temporadas hacia adelante.
    scale = np.sqrt(np.floor(np.arange(horizon) / m) + 1)
    quantiles = {q: point + np.percentile(resid, q) * scale for q in QUANTILES}
    if np.all(y >= 0):
      point = np.maximum(point, 0)
      quantiles = {q: np.maximum(v, 0) for q, v in quantiles.items()}
    quantiles[50] = point
    return Forecast(point=point, quantiles=quantiles)


class TimesFMForecaster:
  """Envoltorio de TimesFM 2.5 (PyTorch)."""

  name = "timesfm-2.5"
  label = "TimesFM 2.5 (200M)"

  def __init__(self):
    import timesfm
    import torch

    torch.set_float32_matmul_precision("high")
    log.info("Cargando %s ...", TIMESFM_CHECKPOINT)
    self._model = timesfm.TimesFM_2p5_200M_torch.from_pretrained(TIMESFM_CHECKPOINT)
    self._model.compile(
      timesfm.ForecastConfig(
        max_context=MAX_CONTEXT,
        max_horizon=MAX_HORIZON,
        normalize_inputs=True,
        use_continuous_quantile_head=True,
        force_flip_invariance=True,
        infer_is_positive=True,
        fix_quantile_crossing=True,
      )
    )
    self._lock = threading.Lock()

  def forecast(self, values: np.ndarray, horizon: int) -> Forecast:
    with self._lock:
      _, q = self._model.forecast(
        horizon=horizon, inputs=[np.asarray(values, dtype=np.float32)]
      )
    # q: (1, horizon, 10) -> [media, p10, p20, ..., p90]
    quantiles = {p: q[0, :, i + 1].astype(float) for i, p in enumerate(QUANTILES)}
    return Forecast(point=quantiles[50], quantiles=quantiles)


def load_forecaster():
  choice = os.environ.get("FORECAST_BACKEND", "auto").lower()
  if choice == "baseline":
    return BaselineForecaster()
  try:
    return TimesFMForecaster()
  except Exception as e:  # sin torch/timesfm, o sin acceso a Hugging Face
    if choice == "timesfm":
      raise
    log.warning("TimesFM no disponible (%s); usando baseline.", e)
    return BaselineForecaster()


def backtest(forecaster, values: np.ndarray, horizon: int) -> dict | None:
  """Pronostica los últimos `horizon` puntos con el resto y mide el error."""
  y = np.asarray(values, dtype=float)
  if len(y) < horizon + 2 * 7:
    return None
  train, actual = y[:-horizon], y[-horizon:]
  fc = forecaster.forecast(train, horizon)
  err = np.abs(actual - fc.point)
  nonzero = actual != 0
  mape = float(np.mean(err[nonzero] / np.abs(actual[nonzero])) * 100) if nonzero.any() else None
  coverage = float(np.mean((actual >= fc.quantiles[10]) & (actual <= fc.quantiles[90])) * 100)
  return {
    "mape": mape,
    "mae": float(err.mean()),
    "coverage80": coverage,
    "point": fc.point.tolist(),
  }
