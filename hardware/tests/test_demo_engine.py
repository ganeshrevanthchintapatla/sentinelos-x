import asyncio
import json
import pathlib
import time

from fastapi.testclient import TestClient

import demo_engine
from demo_engine import DemoConfig, DemoEngine
from test_py39_compat import _union_annotations

HOT = (32.0, 41.0)
NORMAL = (23.0, 41.0)
WET = (23.0, 78.0)
LOOPBACK = ("127.0.0.1", 50000)


def make_engine(**cfg):
    base = dict(step_delay_s=0.03, spread_after_s=999.0, recovered_hold_s=0.15, keepalive_s=0.1,
                inject_interval_s=0.01, nvidia_key="", verify_max_wait_s=5.0)
    base.update(cfg)
    states = []
    eng = DemoEngine(DemoConfig(**base), on_device_state=states.append)
    eng.states = states
    return eng


def run(coro):
    return asyncio.run(coro)


async def until(pred, timeout=5.0):
    end = time.time() + timeout
    while time.time() < end:
        if pred():
            return True
        await asyncio.sleep(0.01)
    return False


def feed(eng, reading, n=1):
    for _ in range(n):
        eng.feed_reading(reading[0], reading[1])


def inc_by_id(eng, iid):
    return next(i for i in eng.snapshot()["incidents"] if i["id"] == iid)


def test_all_healthy_at_start():
    eng = make_engine()
    snap = eng.snapshot()
    assert len(snap["servers"]) == 12
    assert all(s["status"] == "healthy" and s["incident_id"] is None for s in snap["servers"])
    assert snap["incidents"] == []
    assert snap["mode"] == "waiting" and snap["sensor"]["status"] == "none"
    assert snap["agent_mode"] == "scripted"
    assert snap["stats"] == {"open": 0, "resolved": 0, "servers_healthy": 12, "servers_total": 12}
    assert eng.device_state == "HEALTHY"


def test_snapshot_schema_keys():
    eng = make_engine()

    async def go():
        feed(eng, HOT, 2)
        await until(lambda: len(eng.snapshot()["incidents"][0]["steps"]) >= 2)
        return eng.snapshot()

    snap = run(go())
    assert set(snap) == {"version", "now", "agent_mode", "mode", "sensor", "servers", "incidents", "stats"}
    assert set(snap["sensor"]) == {"temp_c", "humidity_pct", "age_s", "status", "limits", "history"}
    assert snap["sensor"]["limits"] == {"temp_c": 30, "humidity_pct": 70}
    assert set(snap["sensor"]["history"][0]) == {"t", "temp_c", "humidity_pct"}
    assert set(snap["servers"][0]) == {"id", "name", "role", "rack", "status", "incident_id", "metrics"}
    assert set(snap["servers"][0]["metrics"]) == {"cpu_pct", "inlet_temp_c", "throttled"}
    inc = snap["incidents"][0]
    assert set(inc) == {"id", "server_id", "server_name", "title", "severity", "status", "opened_at",
                        "resolved_at", "trigger", "steps", "summary"}
    assert set(inc["trigger"]) == {"kind", "value", "limit", "simulated"}
    assert set(inc["steps"][0]) == {"n", "ts", "kind", "title", "detail", "status"}
    assert inc["trigger"]["simulated"] is False and snap["mode"] == "hardware"
    json.dumps(snap)  # serialisable


def test_two_breaching_readings_open_incident_on_a_server():
    eng = make_engine()

    async def go():
        feed(eng, HOT)
        assert eng.snapshot()["incidents"] == []  # one reading is not enough
        feed(eng, HOT)
        return eng.snapshot()

    snap = run(go())
    assert [i["id"] for i in snap["incidents"]] == ["INC-101"]
    inc = snap["incidents"][0]
    assert inc["trigger"]["kind"] == "temperature" and inc["trigger"]["value"] == 32.0
    srv = next(s for s in snap["servers"] if s["id"] == inc["server_id"])
    assert srv["status"] == "affected" and srv["incident_id"] == "INC-101"
    assert snap["stats"]["servers_healthy"] == 11
    assert eng.device_state == "ALERT"


def test_humidity_and_rapid_rise_triggers():
    eng = make_engine()

    async def go():
        feed(eng, WET, 2)
        return eng.snapshot()["incidents"][0]["trigger"]["kind"]

    assert run(go()) == "humidity"
    eng2 = make_engine()

    async def go2():
        feed(eng2, NORMAL)
        feed(eng2, (26.5, 41.0), 2)  # +3.5 C inside 120 s, still under the 30 C limit
        return eng2.snapshot()["incidents"]

    incs = run(go2())
    assert incs and incs[0]["trigger"]["kind"] == "rapid_rise"


def test_single_glitch_and_nan_do_not_open_incident():
    eng = make_engine()

    async def go():
        feed(eng, NORMAL)
        feed(eng, HOT)
        feed(eng, NORMAL)
        feed(eng, HOT)
        feed(eng, NORMAL)
        eng.feed_reading(float("nan"), 40.0)
        eng.feed_reading(40.0, float("inf"))
        feed(eng, HOT)  # NaN readings must not count as normal OR breaching
        return eng.snapshot()

    snap = run(go())
    assert snap["incidents"] == []
    assert len(snap["sensor"]["history"]) == 6


def test_second_excursion_opens_other_server_while_first_still_running():
    eng = make_engine(step_delay_s=0.1)

    async def go():
        feed(eng, HOT, 2)
        feed(eng, HOT, 3)  # same excursion: no second incident
        assert len(eng.snapshot()["incidents"]) == 1
        feed(eng, NORMAL, 2)  # excursion ends
        feed(eng, HOT, 2)  # a NEW excursion
        snap = eng.snapshot()
        assert [i["id"] for i in snap["incidents"]] == ["INC-102", "INC-101"]
        assert snap["incidents"][0]["server_id"] != snap["incidents"][1]["server_id"]
        assert snap["incidents"][1]["status"] != "resolved"
        assert snap["stats"]["open"] == 2

    run(go())


def test_parallel_agents_progress_independently():
    eng = make_engine(step_delay_s=0.06)

    async def go():
        feed(eng, HOT, 2)
        await until(lambda: len(inc_by_id(eng, "INC-101")["steps"]) >= 4)
        feed(eng, NORMAL, 2)
        feed(eng, HOT, 2)
        n1 = len(inc_by_id(eng, "INC-101")["steps"])
        assert len(inc_by_id(eng, "INC-102")["steps"]) == 0  # second agent only just started
        await until(lambda: len(inc_by_id(eng, "INC-102")["steps"]) >= 2)
        a = len(inc_by_id(eng, "INC-101")["steps"])
        b = len(inc_by_id(eng, "INC-102")["steps"])
        assert a > n1 and b >= 2  # both advanced during the same window
        assert a > b  # and the older one is further along
        assert inc_by_id(eng, "INC-101")["status"] != "resolved"
        feed(eng, NORMAL, 2)
        assert await until(lambda: eng.snapshot()["stats"]["resolved"] == 2)

    run(go())


def test_resolution_restores_healthy_and_walks_pipeline():
    eng = make_engine()
    seen = set()

    async def go():
        feed(eng, HOT, 2)

        def watch():
            inc = inc_by_id(eng, "INC-101")
            seen.add(inc["status"])
            sv = next(s for s in eng.snapshot()["servers"] if s["id"] == inc["server_id"])
            seen.add("srv:" + sv["status"])
            return inc["status"] == "resolved"

        feed(eng, NORMAL, 2)
        assert await until(watch)
        return eng.snapshot()

    snap = run(go())
    inc = snap["incidents"][0]
    assert {"srv:affected", "srv:remediating", "fixing", "resolved"} <= seen
    assert all(s["status"] == "healthy" and s["incident_id"] is None for s in snap["servers"])
    assert inc["resolved_at"] >= inc["opened_at"] and inc["summary"]
    kinds = [s["kind"] for s in inc["steps"]]
    assert kinds[0] == "picked_up" and kinds[-1] == "resolved"
    assert kinds.count("tool_call") == 4 and kinds.index("finding") < kinds.index("action") < kinds.index("verify")
    assert all(s["status"] == "done" for s in inc["steps"])
    assert [s["n"] for s in inc["steps"]] == list(range(1, len(inc["steps"]) + 1))
    details = " ".join(s["detail"] for s in inc["steps"])
    assert "32.0" in details and "MODELED" in details and "SIMULATED" in details
    assert snap["stats"] == {"open": 0, "resolved": 1, "servers_healthy": 12, "servers_total": 12}


def test_device_state_sequence_alert_investigating_recovered_healthy():
    eng = make_engine()

    async def go():
        feed(eng, HOT, 2)
        feed(eng, NORMAL, 2)
        assert await until(lambda: eng.states and eng.states[-1] == "HEALTHY" and "RECOVERED" in eng.states, 6)

    run(go())
    assert eng.states == ["ALERT", "INVESTIGATING", "RECOVERED", "HEALTHY"]


def test_verify_waits_for_environment_then_resolves_with_note():
    eng = make_engine(verify_max_wait_s=0.4)

    async def go():
        feed(eng, HOT, 2)  # sensor stays in breach (and fresh)

        def waiting():
            return any(s["kind"] == "verify" and "waiting for environment to stabilise" in s["detail"]
                       for s in inc_by_id(eng, "INC-101")["steps"])

        assert await until(waiting)
        v = [s for s in inc_by_id(eng, "INC-101")["steps"] if s["kind"] == "verify"][0]
        assert v["status"] == "running" and inc_by_id(eng, "INC-101")["status"] == "verifying"
        assert await until(lambda: inc_by_id(eng, "INC-101")["status"] == "resolved", 5)
        return inc_by_id(eng, "INC-101")

    inc = run(go())
    assert "still elevated" in inc["summary"]


def test_verify_passes_once_sensor_normal():
    eng = make_engine()

    async def go():
        feed(eng, HOT, 2)
        assert await until(lambda: any(s["kind"] == "verify" and s["status"] == "running"
                                       for s in inc_by_id(eng, "INC-101")["steps"]))
        assert inc_by_id(eng, "INC-101")["status"] == "verifying"
        feed(eng, NORMAL)
        assert await until(lambda: inc_by_id(eng, "INC-101")["status"] == "resolved")

    run(go())


def test_spread_opens_one_adjacent_rack_incident_per_excursion():
    eng = make_engine(step_delay_s=0.2, spread_after_s=0.1)

    async def go():
        feed(eng, HOT, 2)
        await asyncio.sleep(0.15)
        feed(eng, HOT, 3)
        feed(eng, HOT, 3)
        return eng.snapshot()["incidents"]

    incs = run(go())
    assert [i["id"] for i in incs] == ["INC-102", "INC-101"]
    racks = {i["id"]: next(s["rack"] for s in eng.servers if s["id"] == i["server_id"]) for i in incs}
    assert racks["INC-101"] == "A" and racks["INC-102"] == "B"
    assert "spreading" in incs[0]["title"]


def test_no_incident_when_no_healthy_server_left():
    eng = make_engine()
    for s in eng.servers:
        s["status"] = "affected"

    async def go():
        feed(eng, HOT, 4)
        return eng.snapshot()["incidents"]

    assert run(go()) == []


def test_reset_clears_everything_and_stops_agents():
    eng = make_engine(step_delay_s=0.1)

    async def go():
        feed(eng, HOT, 2)
        await asyncio.sleep(0.05)
        eng.reset()
        snap = eng.snapshot()
        assert snap["incidents"] == [] and snap["sensor"]["history"] == []
        assert all(s["status"] == "healthy" for s in snap["servers"])
        assert eng.device_state == "HEALTHY"
        await asyncio.sleep(0.3)
        assert eng.snapshot()["incidents"] == [] and not eng._tasks
        feed(eng, HOT, 2)  # detection restarted, ids restart too
        return eng.snapshot()["incidents"][0]["id"]

    assert run(go()) == "INC-101"


def test_sse_connect_yields_state_then_changes_then_keepalive():
    eng = make_engine()

    async def go():
        gen = demo_engine.state_events(eng)
        first = await gen.__anext__()
        assert first.startswith("event: state\ndata: ")
        payload = json.loads(first.split("data: ", 1)[1])
        assert payload["version"] == eng.version and len(payload["servers"]) == 12
        assert (await gen.__anext__()) == ": keep-alive\n\n"  # idle -> keep-alive comment
        feed(eng, NORMAL)
        nxt = await gen.__anext__()
        assert nxt.startswith("event: state") and json.loads(nxt.split("data: ", 1)[1])["sensor"]["temp_c"] == 23.0
        await gen.aclose()
        assert eng._subs == []

    run(go())


def test_stream_endpoint_is_event_stream():
    eng = make_engine()
    demo_engine.set_engine(eng)

    async def go():
        resp = await demo_engine.demo_stream()
        assert resp.media_type == "text/event-stream"
        assert resp.headers["cache-control"] == "no-cache"
        frame = await resp.body_iterator.__anext__()
        await resp.body_iterator.aclose()
        return frame

    assert run(go()).startswith("event: state\n")


def test_llm_text_used_only_when_it_succeeds():
    secret = "nvapi-SECRET-KEY-123"
    eng = make_engine(nvidia_key=secret)

    async def ok(messages):
        assert secret not in json.dumps(messages)
        return "  Nemotron wrote this.  "

    eng._llm_complete = ok

    async def go():
        feed(eng, HOT, 2)
        feed(eng, NORMAL, 2)
        assert await until(lambda: inc_by_id(eng, "INC-101")["status"] == "resolved")
        return eng.snapshot()

    snap = run(go())
    assert snap["agent_mode"] == "nemotron"
    assert snap["incidents"][0]["summary"] == "Nemotron wrote this."
    assert any(s["detail"] == "Nemotron wrote this." for s in snap["incidents"][0]["steps"])
    assert secret not in json.dumps(snap)

    eng2 = make_engine(nvidia_key=secret)

    async def boom(messages):
        raise RuntimeError("boom " + secret)

    eng2._llm_complete = boom

    async def go2():
        feed(eng2, HOT, 2)
        feed(eng2, NORMAL, 2)
        assert await until(lambda: inc_by_id(eng2, "INC-101")["status"] == "resolved")
        return eng2.snapshot()

    snap2 = run(go2())
    assert snap2["agent_mode"] == "scripted"
    assert "Root cause" in " ".join(s["detail"] for s in snap2["incidents"][0]["steps"])
    assert secret not in json.dumps(snap2)


# ---------------------------------------------------------------- HTTP / bridge integration
def client_for(eng, **kw):
    import bridge

    demo_engine.set_engine(eng)
    return TestClient(bridge.app, **kw)


def test_reset_and_inject_are_loopback_only():
    eng = make_engine()
    with client_for(eng) as c:  # TestClient peer is "testclient": not loopback
        assert c.post("/demo/reset").status_code == 403
        assert c.post("/demo/inject", json={"kind": "heat"}).status_code == 403
        assert c.get("/demo/state").status_code == 200  # read-only state is open
    with client_for(eng, client=LOOPBACK) as c:
        assert c.post("/demo/reset").json() == {"ok": True}
        assert c.post("/demo/inject", json={"kind": "bogus"}).status_code == 422


def test_inject_heat_opens_simulated_incident_then_normal_recovers():
    eng = make_engine(step_delay_s=0.03)
    with client_for(eng, client=LOOPBACK) as c:
        r = c.post("/demo/inject", json={"kind": "heat", "duration_s": 1})
        assert r.status_code == 200 and r.json()["simulated"] is True
        deadline = time.time() + 5
        snap = c.get("/demo/state").json()
        while not snap["incidents"] and time.time() < deadline:
            time.sleep(0.02)
            snap = c.get("/demo/state").json()
        assert snap["incidents"][0]["trigger"]["simulated"] is True and snap["mode"] == "simulated"
        c.post("/demo/inject", json={"kind": "normal"})
        deadline = time.time() + 8
        while c.get("/demo/state").json()["stats"]["resolved"] < 1 and time.time() < deadline:
            time.sleep(0.05)
        assert c.get("/demo/state").json()["stats"]["resolved"] == 1
        c.post("/demo/reset")
        assert c.get("/demo/state").json()["incidents"] == []


def test_bridge_feeds_engine_and_drives_device_state(monkeypatch):
    import bridge

    monkeypatch.setenv("SENTINEL_DEVICE_TOKEN", "d" * 24)
    monkeypatch.setenv("SENTINEL_ADMIN_TOKEN", "a" * 24)
    monkeypatch.setenv("SENSOR_MIN_INTERVAL_S", "0")
    bridge.store.__init__()
    bridge.reset_sensor_state()
    bridge.set_gateway(None)
    eng = DemoEngine(DemoConfig(step_delay_s=0.04, recovered_hold_s=0.3, nvidia_key="", spread_after_s=999.0),
                     on_device_state=demo_engine._forward_device_state)
    hdr = {"X-Device-Token": "d" * 24}

    def post(t, h):
        return c.post("/hardware/events", headers=hdr, json={
            "device_id": "uno-r4-01", "event_type": "sensor_reading", "temp_c": t, "humidity_pct": h,
            "simulated": False})

    def device():
        return c.get("/hardware/status", headers=hdr).text

    with client_for(eng) as c:
        assert post(23.5, 41).status_code == 202 and device() == "HEALTHY"
        assert post(32, 41).status_code == 202 and post(32, 41).status_code == 202
        assert device() == "ALERT"
        snap = c.get("/demo/state").json()
        assert snap["incidents"][0]["trigger"]["simulated"] is False and snap["mode"] == "hardware"
        deadline = time.time() + 3
        while device() == "ALERT" and time.time() < deadline:
            time.sleep(0.02)
        assert device() == "INVESTIGATING"
        post(23.5, 41)
        post(23.5, 41)
        seen = set()
        deadline = time.time() + 8
        while time.time() < deadline:
            seen.add(device())
            if "RECOVERED" in seen and seen and device() == "HEALTHY":
                break
            time.sleep(0.02)
        assert "RECOVERED" in seen and device() == "HEALTHY"
        # existing demo routes still work next to the new ones
        assert c.get("/demo/events", headers={"X-Admin-Token": "a" * 24}).status_code == 200
        r = c.post("/demo/status", headers={"X-Admin-Token": "a" * 24}, json={"state": "ALERT"})
        assert r.json() == {"state": "ALERT"}
        assert c.get("/demo/events").status_code == 401


def test_servers_are_three_per_rack():
    snap = make_engine().snapshot()
    racks = [s["rack"] for s in snap["servers"]]
    assert sorted(set(racks)) == ["A", "B", "C", "D"] and all(racks.count(r) == 3 for r in "ABCD")


def test_demo_page_points_to_react_ui():
    with client_for(make_engine()) as c:
        r = c.get("/demo")
        assert r.status_code == 200 and r.json()["ui"].endswith(":5173/demo")


def test_cors_allows_dashboard_origins_only_and_admin_checks_origin():
    eng = make_engine()
    with client_for(eng, client=LOOPBACK) as c:
        ok = "http://localhost:5173"
        r = c.get("/demo/state", headers={"Origin": ok})
        assert r.headers["access-control-allow-origin"] == ok
        assert "access-control-allow-credentials" not in r.headers
        r = c.get("/demo/state", headers={"Origin": "http://evil.example"})
        assert "access-control-allow-origin" not in r.headers
        for origin in ("http://127.0.0.1:5173", "http://localhost:4173", ok):
            pre = c.options("/demo/inject", headers={
                "Origin": origin, "Access-Control-Request-Method": "POST",
                "Access-Control-Request-Headers": "content-type"})
            assert pre.status_code == 200 and pre.headers["access-control-allow-origin"] == origin
        pre = c.options("/demo/inject", headers={"Origin": "http://evil.example", "Access-Control-Request-Method": "POST"})
        assert pre.status_code == 400
        # cross-origin POST from the dashboard works (peer is loopback); from an unknown origin it does not
        assert c.post("/demo/reset", headers={"Origin": ok}).status_code == 200
        assert c.post("/demo/reset", headers={"Origin": "http://evil.example"}).status_code == 403


def test_demo_engine_has_no_pep604_annotations():
    assert _union_annotations(pathlib.Path(demo_engine.__file__)) == []
