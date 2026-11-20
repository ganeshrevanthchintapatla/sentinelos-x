// Autonomous demo: fed by the hardware bridge's demo engine (not SpacetimeDB).
// Same look and the same 3D engine as the Situation page.
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { BellRing, Bot, CheckCircle2, ChevronDown, Droplets, FlaskConical, Lightbulb, Loader2, Radio, RotateCcw, ScanSearch, ShieldCheck, Terminal, Thermometer, Wrench, type LucideIcon } from 'lucide-react';
import { EmptyState, MetricCard, Modal, PageHeader, Panel } from '../../components/ui';
import { Sparkline } from '../../components/Sparkline';
import { SEVERITY_LABEL, SeverityBadge } from '../../components/StatusBadge';
import { useDemoStream, type DemoConnection } from '../../hooks/useDemoStream';
import { useDatacenterEngine } from '../../hooks/useDatacenterEngine';
import { STATE_HEX, type RackState } from '../../lib/datacenter3d';
import { buildDemoScene, isActiveIncident } from '../../lib/demoScene';
import type { DemoIncident, DemoSensor, DemoSnapshot, DemoStep, IncidentStatus, StepKind } from '../../lib/demoTypes';

const LEGEND: { state: RackState; label: string }[] = [
  { state: 'healthy', label: 'Healthy' },
  { state: 'critical', label: 'Affected' },
  { state: 'recovering', label: 'Remediating' },
];

const STEP_ICON: Record<StepKind, LucideIcon> = {
  picked_up: BellRing,
  tool_call: Terminal,
  finding: Lightbulb,
  action: Wrench,
  verify: ScanSearch,
  resolved: CheckCircle2,
};

const INC_STATUS: Record<IncidentStatus, { label: string; cls: string }> = {
  open: { label: 'Open', cls: 'bg-red-500/16 text-red-200' },
  investigating: { label: 'Investigating', cls: 'bg-amber-500/14 text-amber-200' },
  fixing: { label: 'Fixing', cls: 'bg-violet-500/14 text-violet-200' },
  verifying: { label: 'Verifying', cls: 'bg-cyan-500/14 text-cyan-200' },
  resolved: { label: 'Resolved', cls: 'bg-emerald-500/12 text-emerald-300' },
};

const CONNECTION: Record<DemoConnection, { label: string; dot: string; text: string; title: string }> = {
  live: { label: 'Live', dot: 'bg-emerald-400', text: 'text-emerald-300', title: 'Streaming from the demo engine' },
  polling: { label: 'Polling', dot: 'bg-amber-400 live-pulse', text: 'text-amber-200', title: 'Stream interrupted, refreshing every 1.5 s' },
  connecting: { label: 'Connecting', dot: 'bg-amber-400 live-pulse', text: 'text-amber-200', title: 'Connecting to the demo engine' },
  offline: { label: 'Offline', dot: 'bg-red-400 live-pulse', text: 'text-red-200', title: 'Demo engine unreachable, retrying' },
  mock: { label: 'Mock data', dot: 'bg-violet-400', text: 'text-violet-200', title: 'Local mock generator (?mock=1)' },
};

function fmtElapsed(s: number) {
  const t = Math.max(0, Math.floor(s));
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
}

function useTick(ms = 1000) {
  const [, set] = useState(0);
  useEffect(() => {
    const t = window.setInterval(() => set(n => n + 1), ms);
    return () => window.clearInterval(t);
  }, [ms]);
}

function triggerText(i: DemoIncident): string {
  const { kind, value, limit } = i.trigger;
  const v = value === null ? '?' : value;
  const l = limit === null ? '?' : limit;
  if (kind === 'humidity_pct' || kind === 'humidity') return `humidity ${v}% ≥ limit ${l}%`;
  if (kind === 'temp_c' || kind === 'temperature' || kind === 'heat') return `temperature ${v} °C ≥ limit ${l} °C`;
  return `${kind || 'signal'} ${v} ≥ limit ${l}`;
}

function Chip({ cls, children }: { cls: string; children: ReactNode }) {
  return <span className={`inline-flex items-center gap-1 rounded-[5px] px-2 py-0.5 text-xs leading-4 font-medium whitespace-nowrap ${cls}`}>{children}</span>;
}

function ConnectionPill({ c }: { c: DemoConnection }) {
  const m = CONNECTION[c];
  return (
    <span className={`inline-flex items-center gap-2 text-[13px] font-medium ${m.text}`} title={m.title} role="status">
      <span className={`size-2 rounded-full ${m.dot}`} aria-hidden />
      {m.label}
    </span>
  );
}

function StepRow({ s, last }: { s: DemoStep; last: boolean }) {
  const Icon = STEP_ICON[s.kind] ?? Terminal;
  const running = s.status === 'running';
  const finding = s.kind === 'finding';
  return (
    <li className="relative flex gap-3 pb-4 last:pb-0">
      {!last && <span className="absolute top-7 bottom-0 left-[13px] w-px bg-ink-700" aria-hidden />}
      <span
        className={`relative z-10 grid size-7 shrink-0 place-items-center rounded-full border ${finding ? 'border-amber-400/60 bg-amber-500/15 text-amber-200' : s.kind === 'resolved' ? 'border-emerald-400/50 bg-emerald-500/12 text-emerald-300' : 'border-ink-600 bg-ink-850 text-slate-300'}`}
      >
        <Icon className="size-3.5" aria-hidden />
      </span>
      <div className={`min-w-0 flex-1 ${finding ? 'rounded-md border border-amber-400/30 bg-amber-500/8 px-2.5 py-1.5' : 'pt-0.5'}`}>
        <div className="flex items-start justify-between gap-2">
          <div className={`min-w-0 text-sm font-medium break-words ${finding ? 'text-amber-100' : 'text-slate-100'}`}>
            {finding && <span className="mr-1.5 text-[11px] font-semibold tracking-wide text-amber-300 uppercase">Finding</span>}
            {s.title}
          </div>
          {running ? (
            <Loader2 className="mt-0.5 size-4 shrink-0 animate-spin text-cyan-300" aria-label="In progress" />
          ) : (
            <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-emerald-400/80" aria-label="Done" />
          )}
        </div>
        {s.detail && <p className="mt-0.5 text-[13px] break-words text-slate-400">{s.detail}</p>}
      </div>
    </li>
  );
}

function Timeline({ steps }: { steps: DemoStep[] }) {
  return (
    <ol aria-label="Agent steps">
      {steps.map((s, i) => (
        <StepRow key={`${s.n}-${i}`} s={s} last={i === steps.length - 1} />
      ))}
    </ol>
  );
}

function Lane({ inc, elapsed, selected }: { inc: DemoIncident; elapsed: number; selected: boolean }) {
  const st = INC_STATUS[inc.status];
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    if (selected) ref.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [selected]);
  return (
    <section ref={ref} className={`panel flex min-w-0 flex-col ${selected ? 'border-slate-400 ring-1 ring-slate-400/60' : ''}`} aria-label={`${inc.id} agent lane`}>
      <header className="space-y-2 border-b border-ink-700 px-4 py-3">
        <div className="flex flex-wrap items-center gap-2">
          <span className="ident text-[13px]">{inc.id}</span>
          <SeverityBadge severity={inc.severity} />
          <Chip cls={st.cls}>{st.label}</Chip>
          <span className="ml-auto font-mono text-base text-slate-100 tabular-nums" title="Time since the incident opened" aria-label={`Elapsed ${fmtElapsed(elapsed)}`}>
            {fmtElapsed(elapsed)}
          </span>
        </div>
        <h3 className="text-[15px] leading-snug font-semibold break-words text-slate-50">{inc.title}</h3>
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px] text-slate-400">
          <span className="font-medium text-slate-200">{inc.server_name}</span>
          <span className="text-slate-600">/</span>
          <span>{triggerText(inc)}</span>
          {inc.trigger.simulated && <Chip cls="bg-violet-500/14 text-violet-200">Simulated</Chip>}
        </div>
      </header>
      <div className="p-4">{inc.steps.length ? <Timeline steps={inc.steps} /> : <p className="text-sm text-slate-500">Waiting for the agent to pick this up…</p>}</div>
    </section>
  );
}

function ResolvedList({ list, selected }: { list: DemoIncident[]; selected: string | null }) {
  if (!list.length) return null;
  return (
    <Panel title={`Resolved (${list.length})`} bodyClass="p-0">
      <ul className="divide-y divide-ink-700">
        {list.map(i => (
          <li key={i.id}>
            <details className="group" open={selected === i.id ? true : undefined}>
              <summary className="flex cursor-pointer list-none flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3 text-sm hover:bg-ink-850 [&::-webkit-details-marker]:hidden">
                <ChevronDown className="size-4 shrink-0 text-slate-500 transition-transform group-open:rotate-180" aria-hidden />
                <span className="ident">{i.id}</span>
                <span className="min-w-0 flex-1 truncate font-medium text-slate-100">{i.title}</span>
                <span className="text-[13px] text-slate-400">{i.server_name}</span>
                <span className="font-mono text-[13px] text-slate-400 tabular-nums">{i.resolved_at !== null ? `fixed in ${fmtElapsed(i.resolved_at - i.opened_at)}` : ''}</span>
                <Chip cls={INC_STATUS.resolved.cls}>Resolved</Chip>
              </summary>
              <div className="space-y-3 border-t border-ink-700 px-4 py-4">
                {i.summary && <p className="text-sm text-slate-300">{i.summary}</p>}
                <p className="text-[13px] text-slate-400">Trigger: {triggerText(i)}{i.trigger.simulated ? ' (simulated)' : ''}</p>
                <Timeline steps={i.steps} />
              </div>
            </details>
          </li>
        ))}
      </ul>
    </Panel>
  );
}

function sensorChip(s: DemoSensor, mode: DemoSnapshot['mode']): { label: string; cls: string } {
  if (mode === 'waiting' || s.status === 'none') return { label: 'Waiting for sensor', cls: 'bg-slate-500/14 text-slate-300' };
  if (s.status === 'silent') return { label: 'Sensor silent', cls: 'bg-red-500/16 text-red-200' };
  if (s.status === 'breach') return { label: 'Limit breached', cls: 'bg-red-500/16 text-red-200' };
  return { label: 'Within limits', cls: 'bg-emerald-500/12 text-emerald-300' };
}

function SensorCard({ snap }: { snap: DemoSnapshot }) {
  const s = snap.sensor;
  const chip = sensorChip(s, snap.mode);
  const hot = s.temp_c !== null && s.temp_c >= s.limits.temp_c;
  const humid = s.humidity_pct !== null && s.humidity_pct >= s.limits.humidity_pct;
  const hist = s.history.slice(-60);
  const temps = hist.map(h => h.temp_c).filter((v): v is number => v !== null);
  const hums = hist.map(h => h.humidity_pct).filter((v): v is number => v !== null);
  const real = snap.mode === 'hardware';
  return (
    <Panel
      title={
        <span className="inline-flex items-center gap-1.5">
          <Radio className="size-3.5" aria-hidden /> Sensor
        </span>
      }
      actions={<span className={`text-xs font-semibold ${real ? 'text-emerald-300' : snap.mode === 'simulated' ? 'text-violet-300' : 'text-slate-400'}`}>{real ? 'Real sensor measurement' : snap.mode === 'simulated' ? 'SIMULATED' : 'Waiting'}</span>}
      className="h-full"
    >
      <div className="space-y-4">
        <div className="flex flex-wrap items-center gap-2">
          <Chip cls={chip.cls}>{chip.label}</Chip>
          {s.age_s !== null && <span className="text-xs text-slate-500">last reading {s.age_s < 1 ? 'just now' : `${Math.round(s.age_s)} s ago`}</span>}
        </div>
        <div className="grid grid-cols-2 gap-4">
          <div aria-label="Temperature">
            <div className="flex items-center gap-1.5 text-[13px] text-slate-400">
              <Thermometer className="size-4" aria-hidden /> Temperature
            </div>
            <div className={`text-[2.6rem] leading-tight font-semibold tabular-nums ${hot ? 'text-red-300' : 'text-slate-50'}`}>
              {s.temp_c === null ? '—' : s.temp_c.toFixed(1)}
              <span className="ml-1 text-lg font-normal text-slate-400">&deg;C</span>
            </div>
            <div className="text-xs text-slate-500">limit {s.limits.temp_c} &deg;C</div>
          </div>
          <div aria-label="Humidity">
            <div className="flex items-center gap-1.5 text-[13px] text-slate-400">
              <Droplets className="size-4" aria-hidden /> Humidity
            </div>
            <div className={`text-[2.6rem] leading-tight font-semibold tabular-nums ${humid ? 'text-red-300' : 'text-slate-50'}`}>
              {s.humidity_pct === null ? '—' : s.humidity_pct.toFixed(0)}
              <span className="ml-1 text-lg font-normal text-slate-400">%</span>
            </div>
            <div className="text-xs text-slate-500">limit {s.limits.humidity_pct}%</div>
          </div>
        </div>
        {temps.length > 1 && <Sparkline label="Temperature" values={temps} color={hot ? '#f87171' : '#94bcfa'} format={v => `${v.toFixed(1)} °C`} height={52} />}
        {hums.length > 1 && <Sparkline label="Humidity" values={hums} color={humid ? '#f87171' : '#34d399'} format={v => `${v.toFixed(0)}%`} height={52} />}
      </div>
    </Panel>
  );
}

function RehearseMenu({ onInject }: { onInject: (k: 'heat' | 'humidity' | 'normal') => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', away);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('mousedown', away);
      document.removeEventListener('keydown', esc);
    };
  }, [open]);
  const item = (kind: 'heat' | 'humidity' | 'normal', label: string) => (
    <button
      key={kind}
      type="button"
      role="menuitem"
      className="block w-full rounded px-2.5 py-1.5 text-left text-sm text-slate-200 hover:bg-ink-800"
      onClick={() => {
        setOpen(false);
        onInject(kind);
      }}
    >
      {label}
    </button>
  );
  return (
    <div ref={ref} className="relative">
      <button type="button" className="btn-ghost" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(o => !o)}>
        <FlaskConical className="size-4" aria-hidden /> Rehearse (simulated) <ChevronDown className="size-3.5" aria-hidden />
      </button>
      {open && (
        <div role="menu" className="panel absolute right-0 z-30 mt-1.5 w-64 border-ink-600 p-1.5 shadow-[0_16px_40px_-12px_rgba(0,0,0,0.7)]">
          <p className="px-2.5 pt-1 pb-1.5 text-xs text-violet-300">Injects a SIMULATED reading, not a real measurement.</p>
          {item('heat', 'Simulate heat breach')}
          {item('humidity', 'Simulate humidity breach')}
          {item('normal', 'Simulate normal readings')}
        </div>
      )}
    </div>
  );
}

export function DemoPage() {
  const { snapshot, connection, serverNow, reset, inject } = useDemoStream();
  useTick(1000);
  const [selected, setSelected] = useState<string | null>(null);
  const [confirmReset, setConfirmReset] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const scene = useMemo(() => (snapshot ? buildDemoScene(snapshot) : { rows: ['A', 'B', 'C', 'D'], slots: 5, racks: [], edges: [], affected: 0 }), [snapshot]);
  const snapRef = useRef(snapshot);
  snapRef.current = snapshot;
  const { canvasHost, labelHost, webgl, replay } = useDatacenterEngine(scene, id => {
    const incs = snapRef.current?.incidents.filter(i => i.server_id === id) ?? [];
    const pick = incs.find(isActiveIncident) ?? incs[0];
    setSelected(pick ? pick.id : null);
  });

  // A newly opened incident replays the detection sweep once.
  const seen = useRef<Set<string> | null>(null);
  useEffect(() => {
    if (!snapshot) return;
    const active = snapshot.incidents.filter(isActiveIncident).map(i => i.id);
    if (seen.current === null) {
      seen.current = new Set(active);
      return;
    }
    const fresh = active.some(id => !seen.current!.has(id));
    active.forEach(id => seen.current!.add(id));
    if (fresh) replay();
  }, [snapshot, replay]);

  const now = serverNow();
  const active = useMemo(() => (snapshot?.incidents ?? []).filter(isActiveIncident).sort((a, b) => a.opened_at - b.opened_at), [snapshot]);
  const resolved = useMemo(() => (snapshot?.incidents ?? []).filter(i => !isActiveIncident(i)).sort((a, b) => (b.resolved_at ?? b.opened_at) - (a.resolved_at ?? a.opened_at)), [snapshot]);

  const doAction = async (fn: () => Promise<boolean>, ok: string) => {
    const done = await fn();
    setNotice(done ? ok : 'The demo engine did not accept the request.');
    window.setTimeout(() => setNotice(null), 4000);
  };

  const stats = snapshot?.stats;
  const nemotron = snapshot?.agent_mode === 'nemotron';
  const flagged = scene.affected;
  const nServers = snapshot?.servers.length ?? 0;

  return (
    <div className="space-y-5">
      <PageHeader
        title="Autonomous demo"
        purpose="Live sensor readings drive simulated servers. An AI agent investigates and fixes each incident on its own, in parallel."
        actions={
          <>
            <RehearseMenu onInject={k => void doAction(() => inject(k), k === 'normal' ? 'Simulated normal readings sent.' : `Simulated ${k} breach injected.`)} />
            <button type="button" className="btn-ghost" onClick={() => setConfirmReset(true)}>
              <RotateCcw className="size-4" aria-hidden /> Reset
            </button>
          </>
        }
      />
      <div aria-live="polite" className="min-h-0 text-sm text-slate-300">
        {notice}
      </div>

      <div className="panel grid grid-cols-2 divide-x divide-ink-700 md:grid-cols-5 [&>*:nth-child(n+3)]:max-md:border-t [&>*:nth-child(n+3)]:max-md:border-ink-700 [&>*:nth-child(odd)]:max-md:border-l-0" aria-label="Summary">
        <MetricCard label="Servers healthy" value={stats ? `${stats.servers_healthy} / ${stats.servers_total}` : '—'} tone={stats && stats.servers_healthy < stats.servers_total ? 'text-amber-200' : 'text-emerald-300'} />
        <MetricCard label="Active incidents" value={stats ? stats.open : '—'} tone={stats && stats.open > 0 ? 'text-red-300' : 'text-slate-50'} />
        <MetricCard label="Resolved" value={stats ? stats.resolved : '—'} />
        <div className="flex min-w-0 flex-col justify-center gap-1.5 px-4 py-3">
          <div className="text-[13px] text-slate-400">Agent</div>
          <div>
            <Chip cls={nemotron ? 'bg-emerald-500/12 text-emerald-300' : 'bg-slate-500/14 text-slate-300'}>
              <Bot className="size-3.5" aria-hidden />
              {nemotron ? 'Nemotron' : 'Scripted agent'}
            </Chip>
          </div>
        </div>
        <div className="col-span-2 flex min-w-0 flex-col justify-center gap-1.5 px-4 py-3 max-md:border-t max-md:border-ink-700 md:col-span-1">
          <div className="text-[13px] text-slate-400">Demo engine</div>
          <ConnectionPill c={connection} />
        </div>
      </div>

      {!snapshot && (
        <Panel>
          <EmptyState
            title={connection === 'offline' ? 'Cannot reach the demo engine' : 'Connecting to the demo engine�'}
            hint="Start the hardware bridge (default http://localhost:8765), or open this page with ?mock=1 to preview with local data."
          />
        </Panel>
      )}
      {(
        <>
          <div className="grid gap-5 xl:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
            <section
              className="relative h-[22rem] overflow-hidden rounded-lg border border-ink-700 bg-ink-950 sm:h-[30rem] xl:h-[34rem]"
              role="img"
              aria-label={`3D datacenter: ${nServers} servers in ${scene.rows.length} racks, ${flagged} flagged.${scene.focusIncident ? ` Focus: ${scene.focusIncident.id} on ${scene.focusIncident.server_name}.` : ''}`}
            >
              <div ref={canvasHost} className="absolute inset-0" />
              <div ref={labelHost} className="dc-labels pointer-events-none absolute inset-0 isolate overflow-hidden" />
              {!webgl && <div className="absolute inset-0 grid place-items-center p-6 text-center text-sm text-slate-500">The 3D view needs WebGL, which this browser has turned off. The agent lanes below show the same information.</div>}
              <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_70%_45%,transparent_40%,rgba(17,19,23,0.75)_100%)]" aria-hidden />
              <div className="absolute top-4 left-4 z-10 w-[min(22rem,calc(100%-2rem))] rounded-lg border border-ink-700 bg-ink-900/92 p-4 backdrop-blur-sm" aria-live="polite">
                {scene.focusIncident ? (
                  <>
                    <div className="flex items-center gap-2 text-xs text-slate-400">
                      <span className={`size-2 rounded-full ${scene.focusIncident.severity === 'high' ? 'live-pulse bg-red-500' : 'bg-amber-400'}`} aria-hidden />
                      <span className="font-mono">{scene.focusIncident.id}</span>
                      <span>{SEVERITY_LABEL[scene.focusIncident.severity]} severity</span>
                    </div>
                    <p className="dc-caption mt-2 text-[1.15rem] leading-snug font-medium text-slate-50" key={scene.focusIncident.id}>
                      {scene.focusIncident.title}
                    </p>
                    <p className="mt-1.5 text-[13px] text-slate-400">
                      {flagged} of {nServers} servers need attention. The agent is on it.
                    </p>
                  </>
                ) : !snapshot ? (
                  <p className="text-sm text-slate-400">Waiting for the demo engine�</p>
                ) : (
                  <>
                    <div className="flex items-center gap-2 text-xs text-emerald-300">
                      <ShieldCheck className="size-3.5" aria-hidden /> All clear
                    </div>
                    <p className="mt-2 text-[1.15rem] leading-snug font-medium text-slate-50">All {nServers} servers are healthy.</p>
                    <p className="mt-1.5 text-[13px] text-slate-400">Each rack is one simulated server. When a reading crosses its limit, the affected server lights up here first.</p>
                  </>
                )}
              </div>
              <div className="absolute bottom-3 left-4 flex flex-wrap gap-x-3 gap-y-1 rounded-md bg-ink-900/80 px-2.5 py-1.5 text-[11px] text-slate-400 backdrop-blur-sm">
                {LEGEND.map(l => (
                  <span key={l.state} className="inline-flex items-center gap-1.5">
                    <span className="size-2 rotate-45 rounded-[1px]" style={{ background: STATE_HEX[l.state] }} aria-hidden />
                    {l.label}
                  </span>
                ))}
              </div>
              <div className="absolute right-4 bottom-3 hidden text-[11px] text-slate-500 sm:block">Racks A-D. Select a server to jump to its incident.</div>
            </section>
            {snapshot && <SensorCard snap={snapshot} />}
          </div>

          {snapshot && (
          <section aria-label="Agent activity" className="space-y-3">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h2 className="text-lg font-semibold text-slate-50">Agent activity</h2>
              <span className="text-[13px] text-slate-400">{active.length ? `${active.length} incident${active.length === 1 ? '' : 's'} handled in parallel` : 'Idle'}</span>
            </div>
            {active.length === 0 ? (
              <Panel>
                <EmptyState title="All systems healthy — monitoring" hint="When a sensor reading crosses its limit, an agent lane opens here and works the incident step by step." icon={ShieldCheck} />
              </Panel>
            ) : (
              <div className="grid items-start gap-4 md:grid-cols-2 2xl:grid-cols-3">
                {active.map(i => (
                  <Lane key={i.id} inc={i} elapsed={now - i.opened_at} selected={selected === i.id} />
                ))}
              </div>
            )}
            <ResolvedList list={resolved} selected={selected} />
          </section>
          )}
        </>
      )}

      <p className="pb-2 text-center text-xs text-slate-500">Sensor readings are real hardware measurements. Servers and remediation are simulated.</p>

      <Modal
        open={confirmReset}
        onClose={() => setConfirmReset(false)}
        title="Reset the demo?"
        footer={
          <>
            <button type="button" className="btn-ghost" onClick={() => setConfirmReset(false)}>
              Cancel
            </button>
            <button
              type="button"
              className="btn-danger"
              onClick={() => {
                setConfirmReset(false);
                setSelected(null);
                void doAction(reset, 'Demo reset.');
              }}
            >
              Reset demo
            </button>
          </>
        }
      >
        <p>This clears all incidents and returns every simulated server to healthy. Sensor readings are not affected.</p>
      </Modal>
    </div>
  );
}
