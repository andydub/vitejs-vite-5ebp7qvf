import os

os.environ.setdefault("FORECAST_BACKEND", "baseline")

from fastapi.testclient import TestClient  # noqa: E402

from main import app  # noqa: E402

client = TestClient(app)


def test_sample_and_forecast():
  rows = client.get("/api/sample").json()["rows"]
  values = [r["ventas"] for r in rows]
  res = client.post("/api/forecast", json={"values": values, "horizon": 30})
  assert res.status_code == 200
  body = res.json()
  assert len(body["point"]) == 30
  assert set(body["quantiles"]) == {f"p{q}" for q in range(10, 100, 10)}
  for lo, mid, hi in zip(body["quantiles"]["p10"], body["point"], body["quantiles"]["p90"]):
    assert lo <= mid <= hi
  assert body["backtest"]["mape"] < 50


def test_rejects_short_series():
  res = client.post("/api/forecast", json={"values": [1, 2, 3], "horizon": 5})
  assert res.status_code == 422
