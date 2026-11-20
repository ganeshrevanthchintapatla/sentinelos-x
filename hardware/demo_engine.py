"""Standalone autonomous incident demo engine (no SpacetimeDB required).

REAL:      the temperature / humidity readings posted by the Arduino (DHT11) to the bridge.
SYNTHETIC: the 8 servers, their metrics, the dependency impact (labelled MODELED) and every remediation
           action (labelled simulated). Nothing here touches real infrastructure.

The engine detects an excursion from the sensor stream (2 consecutive breaching readings), opens an
incident on a healthy synthetic server and runs an autonomous agent per incident, in parallel with any
other incident. If NVIDIA_API_KEY is set, the agent asks a Nemotron model ONLY to word the finding and the
summary; any failure silently falls back to templated text.

Python 3.9 compatible: no `X | Y` annotations, no match statements.
"""
import asyncio
import json
import math
import os
import time
from collections import deque
from typing import Any, Callable, Deque, Dict, List, Literal, Optional

import httpx
from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, ConfigDict, Field

HISTORY_LEN = 90
RISE_WINDOW_S = 120.0
RISE_LIMIT_C = 3.0
DEFAULT_NVIDIA_URL = "https://integrate.api.nvidia.com/v1"
DEFAULT_NVIDIA_MODEL = "nvidia/nemotron-3-ultra-550b-a55b"
LOOPBACK_HOSTS = ("127.0.0.1", "::1", "localhost")
ALLOWED_ORIGINS = ["http://localhost:5173", "http://127.0.0.1:5173", "http://localhost:4173"]

# id, name, role, rack, baseline cpu %
SERVER_DEFS = [
    ("primary-db", "primary-db", "Primary database", "A", 41.0),
    ("app-api", "app-api", "Application API", "A", 36.0),
    ("auth-service", "auth-service", "Authentication service", "B", 22.0),
    ("cache-redis", "cache-redis", "In-memory cache", "B", 27.0),
    ("message-queue", "message-queue", "Message queue", "C", 31.0),
    ("object-storage", "object-storage", "Object storage", "C", 18.0),
    ("api-gateway", "api-gateway", "API gateway", "D", 29.0),
    ("monitoring", "monitoring", "Monitoring stack", "D", 14.0),
    ("replica-db", "replica-db", "Database replica", "A", 33.0),
    ("search-index", "search-index", "Search index", "B", 38.0),
    ("ml-inference", "ml-inference", "ML inference", "C", 52.0),
    ("batch-worker", "batch-worker", "Batch worker", "D", 44.0),
]
RACKS = ["A", "B", "C", "D"]
# server -> servers that depend on it (MODELED, synthetic topology)
DEPENDENTS = {
    "primary-db": ["app-api", "auth-service", "replica-db"],
    "app-api": ["api-gateway"],
    "auth-service": ["api-gateway", "app-api"],
    "cache-redis": ["app-api"],
    "message-queue": ["app-api", "monitoring"],
    "object-storage": ["app-api"],
    "api-gateway": [],
    "monitoring": [],
    "replica-db": [],
    "search-index": ["app-api"],
    "ml-inference": ["app-api"],
    "batch-worker": [],
}
ACTIONS = {
    "primary-db": "Fail read traffic over to the standby replica and throttle batch jobs",
    "app-api": "Shift API traffic to the pool in the unaffected rack and throttle background workers",
    "auth-service": "Route logins to the secondary auth node and pause token-refresh sweeps",
    "cache-redis": "Fail over to the replica cache and warm it from the primary",
    "message-queue": "Pause consumers, drain to the mirror queue and throttle producers",
    "object-storage": "Redirect writes to the other rack and pause background scrubbing",
    "api-gateway": "Drain the gateway node out of the load balancer and cap request rate",
    "monitoring": "Reduce scrape frequency and move dashboards to the standby host",
    "replica-db": "Pause replica snapshots and route read-only queries to the primary until the rack cools",
    "search-index": "Serve queries from the cold shard replica and pause re-indexing",
    "ml-inference": "Scale GPU clocks down and shift inference to the idle pool",
    "batch-worker": "Suspend the batch queue and checkpoint running jobs",
}


def _env_float(name: str, default: float) -> float:
    try:
        return float(os.environ.get(name, default))
    except (TypeError, ValueError):
        return default


class DemoConfig:
    def __init__(self, **overrides: Any) -> None:
        self.temp_limit_c = _env_float("SENSOR_TEMP_LIMIT_C", 30.0)
        self.humidity_limit_pct = _env_float("SENSOR_HUMIDITY_LIMIT_PCT", 70.0)
        self.silent_after_s = _env_float("SENSOR_SILENT_AFTER_S", 30.0)
        self.step_delay_s = _env_float("DEMO_STEP_DELAY_S", 3.0)
        self.spread_after_s = _env_float("DEMO_SPREAD_AFTER_S", 20.0)
        self.verify_max_wait_s = _env_float("DEMO_VERIFY_MAX_WAIT_S", 60.0)
        self.recovered_hold_s = _env_float("DEMO_RECOVERED_HOLD_S", 10.0)
        self.keepalive_s = _env_float("DEMO_SSE_KEEPALIVE_S", 15.0)
        self.inject_interval_s = _env_float("DEMO_INJECT_INTERVAL_S", 1.0)
        self.inject_default_s = _env_float("DEMO_INJECT_DURATION_S", 8.0)
        self.llm_timeout_s = 20.0
        self.nvidia_key = os.environ.get("NVIDIA_API_KEY", "").strip()
        self.nvidia_url = os.environ.get("NVIDIA_BASE_URL", DEFAULT_NVIDIA_URL).strip() or DEFAULT_NVIDIA_URL
        self.nvidia_model = os.environ.get("NVIDIA_MODEL_ID", DEFAULT_NVIDIA_MODEL).strip() or DEFAULT_NVIDIA_MODEL
        for k, v in overrides.items():
            if not hasattr(self, k):
                raise AttributeError(k)
            setattr(self, k, v)


class _Sub:
    def __init__(self, loop: asyncio.AbstractEventLoop) -> None:
        self.loop = loop
        self.event = asyncio.Event()


def _r(x: float, n: int = 1) -> float:
    return round(float(x), n)


class DemoEngine:
    def __init__(
        self,
        config: Optional[DemoConfig] = None,
        clock: Callable[[], float] = time.time,
        on_device_state: Optional[Callable[[str], None]] = None,
    ) -> None:
        self.cfg = config or DemoConfig()
        self.clock = clock
        self.on_device_state = on_device_state
        self.version = 0
        self._subs: List[_Sub] = []
        self._tasks: Dict[str, "asyncio.Task[None]"] = {}
        self._inject_task: Optional["asyncio.Task[None]"] = None
        self._inject_active = False
        self._inject_gen = 0
        self._recover_handle: Optional[asyncio.TimerHandle] = None
        self._llm_ok: Optional[bool] = None
        self._device_state = "HEALTHY"
        self._reset_model()

    # ------------------------------------------------------------------ model
    def _reset_model(self) -> None:
        self.servers: List[Dict[str, Any]] = []
        for sid, name, role, rack, cpu in SERVER_DEFS:
            s = {"id": sid, "name": name, "role": role, "rack": rack, "base_cpu": cpu,
                 "status": "healthy", "incident_id": None}
            self.servers.append(s)
            self._refresh_metrics(s)
        self.incidents: List[Dict[str, Any]] = []  # oldest first internally
        self._seq = 100
        self._next_idx = 0
        self._readings: Deque[Dict[str, Any]] = deque(maxlen=400)
        self._cb = 0
        self._cn = 0
        self._exc: Optional[Dict[str, Any]] = None
        self._recovered_until = 0.0

    def _server(self, sid: str) -> Dict[str, Any]:
        for s in self.servers:
            if s["id"] == sid:
                return s
        raise KeyError(sid)

    def _refresh_metrics(self, s: Dict[str, Any]) -> None:
        rack_i = RACKS.index(s["rack"])
        inlet = 22.0 + 0.4 * rack_i
        cpu = s["base_cpu"]
        throttled = False
        if s["status"] == "affected":
            cpu = min(97.0, cpu + 28.0)
            inlet += 7.5
        elif s["status"] == "remediating":
            cpu = cpu * 0.6
            inlet += 3.0
            throttled = True
        s["metrics"] = {"cpu_pct": _r(cpu), "inlet_temp_c": _r(inlet), "throttled": throttled}

    # ---------------------------------------------------------------- notify
    def subscribe(self) -> _Sub:
        sub = _Sub(asyncio.get_running_loop())
        self._subs.append(sub)
        return sub

    def unsubscribe(self, sub: _Sub) -> None:
        if sub in self._subs:
            self._subs.remove(sub)

    def notify(self) -> None:
        self.version += 1
        self._recompute_device_state()
        for sub in list(self._subs):
            try:
                sub.loop.call_soon_threadsafe(sub.event.set)
            except RuntimeError:  # loop closed
                self.unsubscribe(sub)

    # ----------------------------------------------------------- device state
    def _compute_device_state(self) -> str:
        active = [i for i in self.incidents if i["status"] != "resolved"]
        if any(i["status"] == "open" for i in active):
            return "ALERT"
        if active:
            return "INVESTIGATING"
        if self.clock() < self._recovered_until:
            return "RECOVERED"
        return "HEALTHY"

    def _recompute_device_state(self) -> None:
        new = self._compute_device_state()
        if new == self._device_state:
            return
        self._device_state = new
        if self.on_device_state is not None:
            try:
                self.on_device_state(new)
            except Exception:
                pass

    @property
    def device_state(self) -> str:
        return self._device_state

    # -------------------------------------------------------------- snapshot
    @property
    def agent_mode(self) -> str:
        return "nemotron" if self._llm_ok else "scripted"

    def _latest(self) -> Optional[Dict[str, Any]]:
        return self._readings[-1] if self._readings else None

    def _sensor_status(self, now: float) -> str:
        r = self._latest()
        if r is None:
            return "none"
        if now - r["t"] > self.cfg.silent_after_s:
            return "silent"
        return "breach" if r["breach"] else "normal"

    def snapshot(self) -> Dict[str, Any]:
        now = self.clock()
        r = self._latest()
        if r is None:
            mode = "waiting"
        else:
            mode = "simulated" if r["simulated"] else "hardware"
        history = [
            {"t": x["t"], "temp_c": x["temp_c"], "humidity_pct": x["humidity_pct"]}
            for x in list(self._readings)[-HISTORY_LEN:]
        ]
        by_id = {s["id"]: s for s in self.servers}
        incidents = []
        for inc in reversed(self.incidents):
            incidents.append({
                "id": inc["id"],
                "server_id": inc["server_id"],
                "server_name": by_id[inc["server_id"]]["name"],
                "title": inc["title"],
                "severity": inc["severity"],
                "status": inc["status"],
                "opened_at": inc["opened_at"],
                "resolved_at": inc["resolved_at"],
                "trigger": dict(inc["trigger"]),
                "steps": [dict(st) for st in inc["steps"]],
                "summary": inc["summary"],
            })
        healthy = sum(1 for s in self.servers if s["status"] == "healthy")
        resolved = sum(1 for i in self.incidents if i["status"] == "resolved")
        return {
            "version": self.version,
            "now": now,
            "agent_mode": self.agent_mode,
            "mode": mode,
            "sensor": {
                "temp_c": None if r is None else r["temp_c"],
                "humidity_pct": None if r is None else r["humidity_pct"],
                "age_s": None if r is None else _r(max(0.0, now - r["t"])),
                "status": self._sensor_status(now),
                "limits": {"temp_c": self.cfg.temp_limit_c, "humidity_pct": self.cfg.humidity_limit_pct},
                "history": history,
            },
            "servers": [
                {"id": s["id"], "name": s["name"], "role": s["role"], "rack": s["rack"],
                 "status": s["status"], "incident_id": s["incident_id"], "metrics": dict(s["metrics"])}
                for s in self.servers
            ],
            "incidents": incidents,
            "stats": {
                "open": len(self.incidents) - resolved,
                "resolved": resolved,
                "servers_healthy": healthy,
                "servers_total": len(self.servers),
            },
        }

    # ------------------------------------------------------------- detection
    def _classify(self, now: float, t: float, h: float) -> Optional[Dict[str, Any]]:
        c = self.cfg
        if t >= c.temp_limit_c:
            return {"kind": "temperature", "value": _r(t), "limit": c.temp_limit_c}
        if h >= c.humidity_limit_pct:
            return {"kind": "humidity", "value": _r(h), "limit": c.humidity_limit_pct}
        prior = [x["temp_c"] for x in self._readings if now - RISE_WINDOW_S <= x["t"] <= now]
        if prior:
            rise = t - min(prior)
            if rise >= RISE_LIMIT_C:
                return {"kind": "rapid_rise", "value": _r(rise), "limit": RISE_LIMIT_C}
        return None

    def feed_reading(self, temp_c: Any, humidity_pct: Any, simulated: bool = False, ts: Optional[float] = None) -> None:
        """Accept one sensor reading. Real readings are ignored while a rehearsal injection is running."""
        try:
            t = float(temp_c)
            h = float(humidity_pct)
        except (TypeError, ValueError):
            return
        if not (math.isfinite(t) and math.isfinite(h)):
            return
        if self._inject_active and not simulated:
            return
        now = self.clock() if ts is None else ts
        breach = self._classify(now, t, h)
        self._readings.append({"t": now, "temp_c": _r(t, 2), "humidity_pct": _r(h, 2),
                               "simulated": bool(simulated), "breach": breach is not None})
        if breach is not None:
            self._cb += 1
            self._cn = 0
            if self._exc is None:
                if self._cb >= 2:
                    self._start_excursion(now, breach, bool(simulated))
            else:
                self._maybe_spread(now)
        else:
            self._cn += 1
            self._cb = 0
            if self._exc is not None and self._cn >= 2:
                self._exc = None
        self.notify()

    def _start_excursion(self, now: float, breach: Dict[str, Any], simulated: bool) -> None:
        self._exc = {"started_at": now, "breach": breach, "simulated": simulated,
                     "incident_id": None, "spread_done": False}
        server = self._pick_rotating()
        if server is not None:
            inc = self._open_incident(server, breach, simulated, now, spread_from=None)
            self._exc["incident_id"] = inc["id"]

    def _maybe_spread(self, now: float) -> None:
        exc = self._exc
        if exc is None or exc["spread_done"] or exc["incident_id"] is None:
            return
        primary = self._incident(exc["incident_id"])
        if primary is None or primary["status"] == "resolved":
            return
        if now - exc["started_at"] <= self.cfg.spread_after_s:
            return
        exc["spread_done"] = True  # once per excursion, even if nothing is left to hit
        origin = self._server(primary["server_id"])
        server = self._pick_adjacent(origin["rack"])
        if server is not None:
            self._open_incident(server, exc["breach"], exc["simulated"], now, spread_from=origin)

    def _pick_rotating(self) -> Optional[Dict[str, Any]]:
        n = len(self.servers)
        for off in range(n):
            idx = (self._next_idx + off) % n
            if self.servers[idx]["status"] == "healthy":
                self._next_idx = (idx + 1) % n
                return self.servers[idx]
        return None

    def _pick_adjacent(self, rack: str) -> Optional[Dict[str, Any]]:
        i = RACKS.index(rack)
        order = [RACKS[j] for j in (i + 1, i - 1) if 0 <= j < len(RACKS)]
        for r in order:
            for s in self.servers:
                if s["rack"] == r and s["status"] == "healthy":
                    return s
        for s in self.servers:  # nothing healthy next door: any remaining healthy server
            if s["status"] == "healthy":
                return s
        return None

    def _incident(self, iid: str) -> Optional[Dict[str, Any]]:
        for i in self.incidents:
            if i["id"] == iid:
                return i
        return None

    def _open_incident(self, server: Dict[str, Any], breach: Dict[str, Any], simulated: bool, now: float,
                       spread_from: Optional[Dict[str, Any]]) -> Dict[str, Any]:
        self._seq += 1
        iid = "INC-%d" % self._seq
        kind, value, limit = breach["kind"], breach["value"], breach["limit"]
        rack = server["rack"]
        if kind == "temperature":
            what = "temperature excursion %.1f C (limit %.0f C)" % (value, limit)
            high = value >= limit + 3
        elif kind == "humidity":
            what = "humidity excursion %.0f%% (limit %.0f%%)" % (value, limit)
            high = value >= limit + 10
        else:
            what = "rapid temperature rise +%.1f C within %d s" % (value, int(RISE_WINDOW_S))
            high = value >= 5
        if spread_from is not None:
            title = "Rack %s %s spreading from rack %s" % (rack, what, spread_from["rack"])
            severity = "medium"
        else:
            title = "Rack %s %s" % (rack, what)
            severity = "high" if high else "medium"
        inc = {
            "id": iid, "server_id": server["id"], "title": title, "severity": severity, "status": "open",
            "opened_at": now, "resolved_at": None, "summary": None, "steps": [],
            "trigger": {"kind": kind, "value": value, "limit": limit, "simulated": bool(simulated)},
            "spread_from": spread_from["id"] if spread_from else None,
        }
        self.incidents.append(inc)
        server["status"] = "affected"
        server["incident_id"] = iid
        self._refresh_metrics(server)
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            loop = None
        if loop is not None:
            task = loop.create_task(self._agent(iid))
            self._tasks[iid] = task
            task.add_done_callback(lambda _t, k=iid: self._tasks.pop(k, None))
        return inc

    # ------------------------------------------------------------ agent steps
    def _add_step(self, inc: Dict[str, Any], kind: str, title: str, detail: str = "") -> Dict[str, Any]:
        step = {"n": len(inc["steps"]) + 1, "ts": self.clock(), "kind": kind, "title": title,
                "detail": detail, "status": "running"}
        inc["steps"].append(step)
        self.notify()
        return step

    def _update_step(self, step: Dict[str, Any], detail: Optional[str] = None, done: bool = False,
                     title: Optional[str] = None) -> None:
        if title is not None:
            step["title"] = title
        if detail is not None:
            step["detail"] = detail
        if done:
            step["status"] = "done"
        self.notify()

    def _recent(self, n: int = 5) -> List[Dict[str, Any]]:
        return list(self._readings)[-n:]

    def _facts(self, inc: Dict[str, Any]) -> Dict[str, Any]:
        server = self._server(inc["server_id"])
        rec = self._recent(5)
        temps = [x["temp_c"] for x in rec]
        hums = [x["humidity_pct"] for x in rec]
        allt = [x["temp_c"] for x in self._readings]
        trig = inc["trigger"]
        return {
            "incident": inc["id"], "server": server["name"], "role": server["role"], "rack": server["rack"],
            "trigger_kind": trig["kind"], "trigger_value": trig["value"], "limit": trig["limit"],
            "simulated_input": trig["simulated"],
            "recent_temps_c": temps, "recent_humidity_pct": hums,
            "peak_temp_c": max(allt) if allt else None, "min_temp_c": min(allt) if allt else None,
            "dependents_modeled": DEPENDENTS.get(server["id"], []),
            "spread_from": inc.get("spread_from"),
        }

    @staticmethod
    def _fmt_list(vals: List[float], unit: str) -> str:
        return ", ".join("%.1f" % v for v in vals) + unit if vals else "no readings"

    def _finding_template(self, f: Dict[str, Any]) -> str:
        temps, hums = f["recent_temps_c"], f["recent_humidity_pct"]
        prefix = "[SIMULATED INPUT] " if f["simulated_input"] else ""
        if f["trigger_kind"] == "temperature":
            ev = "measured temperature reached %.1f C against a %.0f C limit" % (f["trigger_value"], f["limit"])
        elif f["trigger_kind"] == "humidity":
            ev = "measured humidity reached %.0f%% against a %.0f%% limit" % (f["trigger_value"], f["limit"])
        else:
            ev = "measured temperature rose %.1f C inside %d s (limit %.0f C)" % (
                f["trigger_value"], int(RISE_WINDOW_S), f["limit"])
        origin = ""
        if f["spread_from"]:
            origin = " Excursion persisted past the spread threshold, so it now reaches this adjacent rack."
        deps = f["dependents_modeled"]
        impact = (
            "MODELED impact: %s depend%s on %s and would see degraded latency if it throttles."
            % (", ".join(deps), "s" if len(deps) == 1 else "", f["server"])
            if deps else "MODELED impact: no downstream dependents; blast radius limited to %s." % f["server"]
        )
        return (
            "%sRoot cause: environmental excursion at rack %s, not a software fault. Evidence: %s; "
            "last readings %s, humidity %s.%s %s"
            % (prefix, f["rack"], ev, self._fmt_list(temps, " C"), self._fmt_list(hums, "%"), origin, impact)
        )

    def _summary_template(self, inc: Dict[str, Any], f: Dict[str, Any], note: str) -> str:
        dur = (inc["resolved_at"] or self.clock()) - inc["opened_at"]
        cur = self._latest()
        now_t = "%.1f C" % cur["temp_c"] if cur else "n/a"
        prefix = "[SIMULATED INPUT] " if f["simulated_input"] else ""
        return (
            "%s%s on %s (rack %s) resolved in %.0f s. Cause: environmental excursion (%s %s, limit %s). "
            "Simulated remediation applied and verified; latest measured temperature %s.%s"
            % (prefix, inc["id"], f["server"], f["rack"], dur, f["trigger_kind"], f["trigger_value"],
               f["limit"], now_t, (" " + note) if note else "")
        )

    async def _llm_complete(self, messages: List[Dict[str, str]]) -> str:
        """One-shot chat completion. The key is only ever placed in the Authorization header."""
        c = self.cfg
        url = c.nvidia_url.rstrip("/") + "/chat/completions"
        async with httpx.AsyncClient(timeout=c.llm_timeout_s) as client:
            resp = await client.post(
                url,
                headers={"Authorization": "Bearer " + c.nvidia_key},
                json={"model": c.nvidia_model, "messages": messages, "temperature": 0.2, "max_tokens": 260},
            )
        resp.raise_for_status()
        return resp.json()["choices"][0]["message"]["content"]

    async def _llm_text(self, purpose: str, facts: Dict[str, Any]) -> Optional[str]:
        if not self.cfg.nvidia_key:
            return None
        messages = [
            {"role": "system", "content": (
                "You are an SRE incident agent in a simulation. Write plain text only (no markdown), 2-3 "
                "sentences. Use ONLY the supplied facts and quote the real measured numbers. Dependency "
                "impact is MODELED and remediation is SIMULATED; say so. Never invent measurements.")},
            {"role": "user", "content": "Write the %s.\nFacts: %s" % (purpose, json.dumps(facts))},
        ]
        try:
            text = await asyncio.wait_for(self._llm_complete(messages), self.cfg.llm_timeout_s + 1)
            text = (text or "").strip()
            if not text:
                raise ValueError("empty")
            self._llm_ok = True
            return text[:900]
        except Exception:  # silent fallback; never surface the key or error text
            self._llm_ok = False
            return None

    async def _step_wait(self, factor: float) -> None:
        await asyncio.sleep(max(0.0, self.cfg.step_delay_s * factor))

    def _sensor_in_breach(self) -> bool:
        return self._sensor_status(self.clock()) == "breach"

    async def _agent(self, iid: str) -> None:
        inc = self._incident(iid)
        if inc is None:
            return
        server = self._server(inc["server_id"])
        sid = server["id"]
        await self._step_wait(0.9)  # detection -> dispatch (device shows ALERT during this window)

        st = self._add_step(inc, "picked_up", "Autonomous agent picked up %s" % iid,
                            "Triage started for %s on rack %s" % (server["name"], server["rack"]))
        await self._step_wait(0.8)
        self._update_step(st, "Assigned to the on-call agent; opening investigation on %s (rack %s)"
                          % (server["name"], server["rack"]), done=True)
        inc["status"] = "investigating"
        self.notify()

        # tool calls
        st = self._add_step(inc, "tool_call", "get_incident(%s)" % iid, "calling...")
        await self._step_wait(1.0)
        self._update_step(st, "%s | %s | severity %s | trigger %s %s (limit %s)%s" % (
            iid, inc["title"], inc["severity"], inc["trigger"]["kind"], inc["trigger"]["value"],
            inc["trigger"]["limit"], " | SIMULATED input" if inc["trigger"]["simulated"] else ""), done=True)

        st = self._add_step(inc, "tool_call", "get_sensor_readings(window=5)", "calling...")
        await self._step_wait(1.1)
        rec = self._recent(5)
        if rec:
            sim = any(x["simulated"] for x in rec)
            det = "%d %s readings (temp C): %s; humidity %%: %s%s" % (
                len(rec), "simulated" if sim else "real", ", ".join("%.1f" % x["temp_c"] for x in rec),
                ", ".join("%.0f" % x["humidity_pct"] for x in rec),
                " (SIMULATED rehearsal input)" if any(x["simulated"] for x in rec) else "")
        else:
            det = "no readings available"
        self._update_step(st, det, done=True)

        st = self._add_step(inc, "tool_call", "get_server_metrics(%s)" % sid, "calling...")
        await self._step_wait(0.9)
        m = server["metrics"]
        self._update_step(st, "cpu %.1f%%, inlet %.1f C, throttled=%s (synthetic metrics)" % (
            m["cpu_pct"], m["inlet_temp_c"], str(m["throttled"]).lower()), done=True)

        st = self._add_step(inc, "tool_call", "check_dependencies(%s)" % sid, "calling...")
        await self._step_wait(0.9)
        deps = DEPENDENTS.get(sid, [])
        self._update_step(st, ("dependents: %s (MODELED topology)" % ", ".join(deps)) if deps
                          else "no downstream dependents (MODELED topology)", done=True)

        # finding
        facts = self._facts(inc)
        st = self._add_step(inc, "finding", "Analysing evidence for root cause", "correlating sensor data with rack topology...")
        llm = asyncio.ensure_future(self._llm_text("root-cause finding", facts))
        await self._step_wait(1.2)
        text = await llm
        self._update_step(st, text or self._finding_template(facts), done=True, title="Root cause: environmental excursion at rack %s" % server["rack"])

        # action
        inc["status"] = "fixing"
        server["status"] = "remediating"
        self._refresh_metrics(server)
        action = ACTIONS.get(sid, "Throttle workloads and enable rack cooling")
        st = self._add_step(inc, "action", "Executing remediation (simulated)", action + "...")
        await self._step_wait(1.3)
        self._update_step(st, "%s; enabled rack %s cooling boost. SIMULATED remediation: no real infrastructure was changed."
                          % (action, server["rack"]), done=True)

        # verify
        inc["status"] = "verifying"
        st = self._add_step(inc, "verify", "Verifying recovery", "server metrics settling...")
        await self._step_wait(1.0)
        waited = 0.0
        poll = max(0.01, min(0.5, self.cfg.step_delay_s / 2.0))
        note = ""
        while self._sensor_in_breach():
            if waited >= self.cfg.verify_max_wait_s:
                note = "Sensor still elevated after %d s; resolving on remediation evidence only." % int(self.cfg.verify_max_wait_s)
                break
            self._update_step(st, "waiting for environment to stabilise")
            await asyncio.sleep(poll)
            waited += poll
        cur = self._latest()
        base = 22.0 + 0.4 * RACKS.index(server["rack"])
        server["metrics"]["inlet_temp_c"] = _r(base + 0.6)
        self.notify()
        vdet = "inlet temperature settled to %.1f C (synthetic); cpu %.1f%%" % (
            server["metrics"]["inlet_temp_c"], server["metrics"]["cpu_pct"])
        if cur is not None and not note:
            vdet += "; measured sensor reading %.1f C / %.0f%% within limits" % (cur["temp_c"], cur["humidity_pct"])
        elif note:
            vdet += "; " + note
        self._update_step(st, vdet, done=True)

        # resolve
        st = self._add_step(inc, "resolved", "Incident resolved", "writing summary...")
        facts2 = self._facts(inc)
        facts2["verify_note"] = note
        inc["resolved_at"] = self.clock()
        llm = asyncio.ensure_future(self._llm_text("incident summary", facts2))
        await self._step_wait(0.8)
        text = await llm
        summary = text or self._summary_template(inc, facts2, note)
        inc["summary"] = summary
        inc["resolved_at"] = self.clock()
        inc["status"] = "resolved"
        server["status"] = "healthy"
        server["incident_id"] = None
        self._refresh_metrics(server)
        if not any(i["status"] != "resolved" for i in self.incidents):
            self._recovered_until = self.clock() + self.cfg.recovered_hold_s  # before notify: HEALTHY must not flash
            self._schedule_recovered_expiry()
        self._update_step(st, summary, done=True)

    def _schedule_recovered_expiry(self) -> None:
        if self._recover_handle is not None:
            self._recover_handle.cancel()
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            return
        self._recover_handle = loop.call_later(self.cfg.recovered_hold_s + 0.05, self.notify)

    # ------------------------------------------------------------ inject/reset
    def start_inject(self, kind: str, duration_s: Optional[float] = None) -> int:
        """Feed clearly SIMULATED readings in the background; returns the number of readings."""
        interval = max(0.0, self.cfg.inject_interval_s)
        if duration_s is None:
            count = 3 if kind == "normal" else max(2, int(round(self.cfg.inject_default_s / max(interval, 0.001))))
        else:
            count = max(2, int(round(duration_s / max(interval, 0.001))))
        if self._inject_task is not None and not self._inject_task.done():
            self._inject_task.cancel()
        self._inject_gen += 1
        self._inject_active = True
        self._inject_task = asyncio.get_running_loop().create_task(
            self._inject_run(kind, count, interval, self._inject_gen))
        return count

    async def _inject_run(self, kind: str, count: int, interval: float, gen: int) -> None:
        try:
            for i in range(count):
                jitter = ((i * 7) % 5 - 2) * 0.1  # tiny deterministic wobble
                if kind == "heat":
                    t, h = 32.0 + jitter, 41.0
                elif kind == "humidity":
                    t, h = 23.0 + jitter, 78.0
                else:
                    t, h = 23.0 + jitter, 41.0
                self.feed_reading(t, h, simulated=True)
                await asyncio.sleep(interval)
        finally:
            if gen == self._inject_gen:
                self._inject_active = False

    def reset(self) -> None:
        for task in list(self._tasks.values()):
            task.cancel()
        self._tasks.clear()
        if self._inject_task is not None:
            self._inject_task.cancel()
            self._inject_task = None
        self._inject_active = False
        if self._recover_handle is not None:
            self._recover_handle.cancel()
            self._recover_handle = None
        self._reset_model()
        self._llm_ok = None
        self.notify()  # recomputes the device state back to HEALTHY


# ---------------------------------------------------------------- module API
_engine: Optional[DemoEngine] = None
device_state_hook: Optional[Callable[[str], None]] = None  # set by bridge.py


def _forward_device_state(state: str) -> None:
    hook = device_state_hook
    if hook is not None:
        hook(state)


def get_engine() -> DemoEngine:
    global _engine
    if _engine is None:
        _engine = DemoEngine(on_device_state=_forward_device_state)
    return _engine


def set_engine(engine: Optional[DemoEngine]) -> None:
    global _engine
    _engine = engine


def feed_sensor_reading(temp_c: float, humidity_pct: float) -> None:
    """Called by the bridge for every accepted REAL reading. Never raises."""
    try:
        get_engine().feed_reading(temp_c, humidity_pct, simulated=False)
    except Exception:
        pass


def _require_loopback(request: Request) -> None:
    """Admin-ish endpoints: peer must be loopback, and a browser Origin (if any) must be a known UI origin."""
    origin = request.headers.get("origin")
    if origin is not None and origin not in ALLOWED_ORIGINS:
        raise HTTPException(status_code=403, detail="origin not allowed")
    host = request.client.host if request.client else ""
    if host in LOOPBACK_HOSTS or host.startswith("::ffff:127."):
        return
    raise HTTPException(status_code=403, detail="loopback only")


class InjectBody(BaseModel):
    model_config = ConfigDict(extra="forbid")
    kind: Literal["heat", "humidity", "normal"]
    duration_s: Optional[float] = Field(default=None, ge=1, le=120, allow_inf_nan=False)


def sse_message(snapshot: Dict[str, Any]) -> str:
    return "event: state\ndata: %s\n\n" % json.dumps(snapshot, separators=(",", ":"))


async def state_events(engine: DemoEngine):
    """Async generator of SSE frames: state on connect, on every change, keep-alive comments."""
    sub = engine.subscribe()
    try:
        yield sse_message(engine.snapshot())
        while True:
            try:
                await asyncio.wait_for(sub.event.wait(), engine.cfg.keepalive_s)
            except asyncio.TimeoutError:
                yield ": keep-alive\n\n"
                continue
            sub.event.clear()  # clear BEFORE snapshotting so a change during the yield is not lost
            yield sse_message(engine.snapshot())
    finally:
        engine.unsubscribe(sub)


router = APIRouter()


@router.get("/demo/state")
def demo_state() -> Dict[str, Any]:
    return get_engine().snapshot()


@router.get("/demo/stream")
async def demo_stream() -> StreamingResponse:
    return StreamingResponse(
        state_events(get_engine()),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no", "Connection": "keep-alive"},
    )


@router.post("/demo/reset")
async def demo_reset(request: Request) -> Dict[str, Any]:
    _require_loopback(request)
    get_engine().reset()
    return {"ok": True}


@router.post("/demo/inject")
async def demo_inject(body: InjectBody, request: Request) -> Dict[str, Any]:
    _require_loopback(request)
    n = get_engine().start_inject(body.kind, body.duration_s)
    return {"ok": True, "kind": body.kind, "simulated": True, "readings": n}


@router.get("/demo")
def demo_page() -> Dict[str, Any]:
    """The UI lives in the React dashboard; this is just a pointer."""
    ui = os.environ.get("DEMO_UI_URL", "http://localhost:5173/demo")
    return {"ui": ui, "state": "/demo/state", "stream": "/demo/stream",
            "note": "Open the React dashboard at the ui URL; it consumes /demo/state and /demo/stream."}
