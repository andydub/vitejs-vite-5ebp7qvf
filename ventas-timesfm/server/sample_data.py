"""Datos de ventas diarias sintéticos para la demo."""

from __future__ import annotations

from datetime import date, timedelta

import numpy as np


def sample_sales(days: int = 730, seed: int = 7) -> list[dict]:
  rng = np.random.default_rng(seed)
  start = date.today() - timedelta(days=days)
  t = np.arange(days)

  trend = 1200 + 0.9 * t
  # Más ventas viernes y sábado, menos domingo y lunes.
  weekday_effect = np.array([-0.08, -0.03, 0.0, 0.04, 0.15, 0.22, -0.15])
  weekdays = np.array([(start + timedelta(days=int(i))).weekday() for i in t])
  weekly = 1 + weekday_effect[weekdays]
  # Pico en diciembre, valle a mitad de año.
  day_of_year = np.array([(start + timedelta(days=int(i))).timetuple().tm_yday for i in t])
  yearly = 1 + 0.18 * np.cos(2 * np.pi * (day_of_year - 355) / 365.25)
  # Promociones puntuales.
  promo = np.ones(days)
  promo[rng.choice(days, size=days // 40, replace=False)] = 1.35
  noise = rng.normal(1, 0.05, days)

  sales = np.round(trend * weekly * yearly * promo * noise)
  return [
    {"fecha": (start + timedelta(days=int(i))).isoformat(), "ventas": float(v)}
    for i, v in zip(t, sales)
  ]
