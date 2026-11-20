// Local mock of the demo engine (`?mock=1`) so the whole page can be checked without the backend.
// Timeline: all healthy -> incident on one server (a step every ~3 s) -> a second overlapping
// incident -> resolutions -> quiet, then the cycle repeats.
import type { DemoIncident, DemoServer, DemoSnapshot, DemoStep, StepKind } from './demoTypes';

const STEP_S = 3;
const CYCLE_S = 50;
const ROLES = ['web', 'api', 'db', 'cache'];
const SERVERS: { id: string; name: string; role: string; rack: string }[] = ['A', 'B', 'C', 'D'].flatMap((rack, r) =>
  [1, 2, 3].map(n => ({ id: `srv-${rack.toLowerCase()}${n}`, name: `${rack}${n}-${ROLES[(r + n) % 4]}`, role: ROLES[(r + n) % 4]!, rack }))
);

type Kind = 'heat' | 'humidity' | 'normal';
interface Script {
  id: string;
  server: number;
  start: number; // seconds, absolute
  kind: Kind;
  simulated: boolean;
}

const STEP_KINDS: StepKind[] = ['picked_up', 'tool_call', 'finding', 'action', 'verify', 'resolved'];

function stepsFor(kind: Kind, srv: string, value: number): { kind: StepKind; title: string; detail: string }[] {
  const what = kind === 'heat' ? 'Inlet temperature' : 'Relative humidity';
  const unit = kind === 'heat' ? 'C' : '%';
  return [
    { kind: 'picked_up', title: `Agent picked up alert on ${srv}`, detail: `${what} ${value}${unit} crossed its limit.` },
    { kind: 'tool_call', title: 'get_server_metrics', detail: `cpu 71%, inlet ${kind === 'heat' ? value : 26}C, fan 94%` },
    { kind: 'finding', title: kind === 'heat' ? 'Cooling airflow is blocked at rack inlet' : 'Condensation risk near power supply', detail: `Root cause matches the ${what.toLowerCase()} reading from the sensor.` },
    { kind: 'action', title: kind === 'heat' ? 'Throttle workloads and raise fan curve' : 'Drain workloads to a dry rack', detail: 'Remediation applied (simulated).' },
    { kind: 'verify', title: 'Re-checking sensor and server metrics', detail: 'Waiting for readings to return inside limits.' },
    { kind: 'resolved', title: 'Incident resolved', detail: 'Readings are back inside limits.' },
  ];
}

export interface DemoMock {
  snapshot(nowMs: number): DemoSnapshot;
  reset(): void;
  inject(kind: Kind): void;
}

export function createDemoMock(startMs: number = Date.now()): DemoMock {
  let t0 = startMs / 1000;
  let injected: Script[] = [];
  let counter = 0;
  let version = 0;

  const cycleScripts = (t: number): Script[] => {
    const cycle = Math.floor((t - t0) / CYCLE_S);
    const out: Script[] = [];
    for (let c = 0; c <= cycle; c++) {
      const base = t0 + c * CYCLE_S;
      out.push({ id: `INC-${c * 2 + 1}`, server: (2 + c * 5) % 12, start: base + 5, kind: 'humidity', simulated: false });
      out.push({ id: `INC-${c * 2 + 2}`, server: (7 + c * 3) % 12, start: base + 8, kind: 'heat', simulated: false });
    }
    return out;
  };

  function snapshot(nowMs: number): DemoSnapshot {
    const now = nowMs / 1000;
    version += 1;
    const scripts = [...cycleScripts(now), ...injected].filter(s => s.start <= now).sort((a, b) => b.start - a.start);
    const incidents: DemoIncident[] = [];
    const status = new Map<string, { status: DemoServer['status']; incident: string }>();
    for (const sc of scripts) {
      const srv = SERVERS[sc.server]!;
      const value = sc.kind === 'heat' ? 34 : 78;
      const defs = stepsFor(sc.kind, srv.name, value);
      const done = Math.min(defs.length, Math.floor((now - sc.start) / STEP_S) + 1);
      const steps: DemoStep[] = defs.slice(0, done).map((d, i) => ({
        n: i + 1,
        ts: sc.start + i * STEP_S,
        kind: STEP_KINDS[i]!,
        title: d.title,
        detail: d.detail,
        status: i === done - 1 && done < defs.length ? 'running' : 'done',
      }));
      const resolved = done >= defs.length;
      const st = resolved ? 'resolved' : done <= 1 ? 'open' : done <= 3 ? 'investigating' : done === 4 ? 'fixing' : 'verifying';
      incidents.push({
        id: sc.id,
        server_id: srv.id,
        server_name: srv.name,
        title: sc.kind === 'heat' ? `High inlet temperature on ${srv.name}` : `High humidity near ${srv.name}`,
        severity: sc.kind === 'heat' ? 'high' : 'medium',
        status: st,
        opened_at: sc.start,
        resolved_at: resolved ? sc.start + (defs.length - 1) * STEP_S : null,
        trigger: { kind: sc.kind === 'heat' ? 'temp_c' : 'humidity_pct', value, limit: sc.kind === 'heat' ? 30 : 70, simulated: sc.simulated },
        steps,
        summary: resolved ? `${defs[2]!.title}. Fixed and verified.` : null,
      });
      if (!resolved) status.set(srv.id, { status: done <= 3 ? 'affected' : 'remediating', incident: sc.id });
    }
    const servers: DemoServer[] = SERVERS.map((s, i) => {
      const st = status.get(s.id);
      return {
        id: s.id,
        name: s.name,
        role: s.role,
        rack: s.rack,
        status: st?.status ?? 'healthy',
        incident_id: st?.incident ?? null,
        metrics: { cpu_pct: 30 + ((i * 13 + Math.floor(now / 4)) % 40), inlet_temp_c: st?.status === 'affected' ? 33 : 24 + (i % 3), throttled: st?.status === 'remediating' },
      };
    });
    const active = incidents.filter(i => i.status !== 'resolved');
    const heat = active.some(i => i.trigger.kind === 'temp_c');
    const wet = active.some(i => i.trigger.kind === 'humidity_pct');
    const tempAt = (t: number) => 24 + Math.sin(t / 6) * 0.4 + (heat ? 9 : 0);
    const humAt = (t: number) => 48 + Math.cos(t / 9) * 1.2 + (wet ? 30 : 0);
    const history = Array.from({ length: 60 }, (_, k) => {
      const t = now - (59 - k) * 2;
      return { t, temp_c: +tempAt(t).toFixed(1), humidity_pct: +humAt(t).toFixed(1) };
    });
    return {
      version,
      now,
      agent_mode: 'scripted',
      mode: 'simulated',
      sensor: {
        temp_c: +tempAt(now).toFixed(1),
        humidity_pct: +humAt(now).toFixed(1),
        age_s: 1,
        status: heat || wet ? 'breach' : 'normal',
        limits: { temp_c: 30, humidity_pct: 70 },
        history,
      },
      servers,
      incidents,
      stats: {
        open: active.length,
        resolved: incidents.length - active.length,
        servers_healthy: servers.filter(s => s.status === 'healthy').length,
        servers_total: servers.length,
      },
    };
  }

  return {
    snapshot,
    reset() {
      t0 = Date.now() / 1000 + 4;
      injected = [];
    },
    inject(kind) {
      if (kind === 'normal') return; // back to normal readings: nothing new to open
      counter += 1;
      injected.push({ id: `INC-R${counter}`, server: (counter * 5 + 1) % 12, start: Date.now() / 1000, kind, simulated: true });
    },
  };
}
