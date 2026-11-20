// Snapshot contract of the hardware bridge's demo engine (GET /demo/state, SSE /demo/stream).
// Parsing is defensive: a malformed or partial snapshot never throws, it degrades to safe defaults.

export type DemoMode = 'hardware' | 'simulated' | 'waiting';
export type SensorStatus = 'none' | 'normal' | 'breach' | 'silent';
export type ServerStatus = 'healthy' | 'affected' | 'remediating';
export type IncidentStatus = 'open' | 'investigating' | 'fixing' | 'verifying' | 'resolved';
export type StepKind = 'picked_up' | 'tool_call' | 'finding' | 'action' | 'verify' | 'resolved';

export interface DemoHistoryPoint {
  t: number;
  temp_c: number | null;
  humidity_pct: number | null;
}
export interface DemoSensor {
  temp_c: number | null;
  humidity_pct: number | null;
  age_s: number | null;
  status: SensorStatus;
  limits: { temp_c: number; humidity_pct: number };
  history: DemoHistoryPoint[];
}
export interface DemoServer {
  id: string;
  name: string;
  role: string;
  rack: string;
  status: ServerStatus;
  incident_id: string | null;
  metrics: { cpu_pct: number | null; inlet_temp_c: number | null; throttled: boolean };
}
export interface DemoStep {
  n: number;
  ts: number;
  kind: StepKind;
  title: string;
  detail: string;
  status: 'running' | 'done';
}
export interface DemoIncident {
  id: string;
  server_id: string;
  server_name: string;
  title: string;
  severity: 'high' | 'medium';
  status: IncidentStatus;
  opened_at: number;
  resolved_at: number | null;
  trigger: { kind: string; value: number | null; limit: number | null; simulated: boolean };
  steps: DemoStep[];
  summary: string | null;
}
export interface DemoSnapshot {
  version: number;
  now: number;
  agent_mode: 'nemotron' | 'scripted';
  mode: DemoMode;
  sensor: DemoSensor;
  servers: DemoServer[];
  incidents: DemoIncident[];
  stats: { open: number; resolved: number; servers_healthy: number; servers_total: number };
}

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = (v: unknown, d = ''): string => (typeof v === 'string' ? v : v == null ? d : String(v));
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const oneOf = <T extends string>(v: unknown, allowed: readonly T[], d: T): T => (typeof v === 'string' && (allowed as readonly string[]).includes(v) ? (v as T) : d);

const SERVER_STATUS = ['healthy', 'affected', 'remediating'] as const;
const INCIDENT_STATUS = ['open', 'investigating', 'fixing', 'verifying', 'resolved'] as const;
const STEP_KIND = ['picked_up', 'tool_call', 'finding', 'action', 'verify', 'resolved'] as const;

export function parseSnapshot(raw: unknown): DemoSnapshot | null {
  let o: unknown = raw;
  if (typeof raw === 'string') {
    try {
      o = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (!isRec(o) || !Array.isArray(o.servers)) return null;
  const s = isRec(o.sensor) ? o.sensor : {};
  const lim = isRec(s.limits) ? s.limits : {};
  const sensor: DemoSensor = {
    temp_c: num(s.temp_c),
    humidity_pct: num(s.humidity_pct),
    age_s: num(s.age_s),
    status: oneOf(s.status, ['none', 'normal', 'breach', 'silent'] as const, 'none'),
    limits: { temp_c: num(lim.temp_c) ?? 30, humidity_pct: num(lim.humidity_pct) ?? 70 },
    history: arr(s.history)
      .filter(isRec)
      .map(h => ({ t: num(h.t) ?? 0, temp_c: num(h.temp_c), humidity_pct: num(h.humidity_pct) })),
  };
  const servers: DemoServer[] = arr(o.servers)
    .filter(isRec)
    .map(v => {
      const m = isRec(v.metrics) ? v.metrics : {};
      return {
        id: str(v.id),
        name: str(v.name, str(v.id)),
        role: str(v.role),
        rack: str(v.rack, 'A'),
        status: oneOf(v.status, SERVER_STATUS, 'healthy'),
        incident_id: v.incident_id == null ? null : str(v.incident_id),
        metrics: { cpu_pct: num(m.cpu_pct), inlet_temp_c: num(m.inlet_temp_c), throttled: m.throttled === true },
      };
    })
    .filter(v => v.id);
  const incidents: DemoIncident[] = arr(o.incidents)
    .filter(isRec)
    .map(v => {
      const t = isRec(v.trigger) ? v.trigger : {};
      return {
        id: str(v.id),
        server_id: str(v.server_id),
        server_name: str(v.server_name, str(v.server_id)),
        title: str(v.title, 'Incident'),
        severity: oneOf(v.severity, ['high', 'medium'] as const, 'medium'),
        status: oneOf(v.status, INCIDENT_STATUS, 'open'),
        opened_at: num(v.opened_at) ?? 0,
        resolved_at: num(v.resolved_at),
        trigger: { kind: str(t.kind), value: num(t.value), limit: num(t.limit), simulated: t.simulated === true },
        steps: arr(v.steps)
          .filter(isRec)
          .map((st, i) => ({
            n: num(st.n) ?? i + 1,
            ts: num(st.ts) ?? 0,
            kind: oneOf(st.kind, STEP_KIND, 'tool_call'),
            title: str(st.title),
            detail: str(st.detail),
            status: oneOf(st.status, ['running', 'done'] as const, 'done'),
          })),
        summary: v.summary == null ? null : str(v.summary),
      };
    })
    .filter(v => v.id);
  const healthy = servers.filter(v => v.status === 'healthy').length;
  const st = isRec(o.stats) ? o.stats : {};
  return {
    version: num(o.version) ?? 0,
    now: num(o.now) ?? Date.now() / 1000,
    agent_mode: o.agent_mode === 'nemotron' ? 'nemotron' : 'scripted',
    mode: oneOf(o.mode, ['hardware', 'simulated', 'waiting'] as const, 'waiting'),
    sensor,
    servers,
    incidents,
    stats: {
      open: num(st.open) ?? incidents.filter(i => i.status !== 'resolved').length,
      resolved: num(st.resolved) ?? incidents.filter(i => i.status === 'resolved').length,
      servers_healthy: num(st.servers_healthy) ?? healthy,
      servers_total: num(st.servers_total) ?? servers.length,
    },
  };
}
