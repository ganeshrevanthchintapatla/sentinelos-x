# Autonomous incident demo (no SpacetimeDB)

**Run:** `cd hardware; .\start_demo.ps1` (loads `.env`, makes `.venv`, serves the bridge on `:8765`, prints the laptop IPv4).
Start the React dashboard separately (`npm run dev` in `SentinelOS-X/frontend`) and open `http://localhost:5173/demo`.
`http://localhost:8765/demo` only returns a pointer to that UI; data is at `/demo/state` (JSON) and `/demo/stream` (SSE).

**Trigger with the real sensor:** the Arduino (unchanged firmware) posts DHT11 readings to `/hardware/events`.
Breathe on the sensor or hold a hair dryer near it (not touching) until temp >= 30 C, humidity >= 70 %, or temp rises 3 C in 2 min.
Two consecutive breaching readings open an incident on the next healthy server; a breach lasting >20 s spreads to one adjacent rack.
Each incident gets its own agent and runs in parallel; it resolves only after verification, which waits (max 60 s) for the sensor to calm down.
LED/OLED follow: ALERT, INVESTIGATING, RECOVERED (~10 s), HEALTHY.

**Rehearsal without hardware (loopback only, labelled SIMULATED):**
`curl -X POST localhost:8765/demo/inject -H "Content-Type: application/json" -d '{"kind":"heat"}'` (also `humidity`, `normal`; optional `"duration_s"`).
`curl -X POST localhost:8765/demo/reset` clears incidents and makes all servers healthy. Real readings are ignored while an injection runs.

**Real vs synthetic:** REAL = sensor temperature/humidity, detection, timestamps and the numbers quoted in findings.
SYNTHETIC = the 12 servers, their CPU/inlet metrics, dependency impact (labelled MODELED) and every remediation (labelled simulated; nothing real is changed).
Agent text is templated unless `NVIDIA_API_KEY` is set (then Nemotron writes finding/summary only; `agent_mode` shows which was used).

**Tuning (env):** `SENSOR_TEMP_LIMIT_C`, `SENSOR_HUMIDITY_LIMIT_PCT`, `DEMO_STEP_DELAY_S` (default 3), `DEMO_SPREAD_AFTER_S` (20), `DEMO_VERIFY_MAX_WAIT_S` (60).
CORS allows only `localhost:5173`, `127.0.0.1:5173`, `localhost:4173`. State lives in memory; restarting the bridge resets everything to healthy.
