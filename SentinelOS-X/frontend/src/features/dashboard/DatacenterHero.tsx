// Situation hero: the live 3D datacenter. When an incident is detected the
// view sweeps the floor from above, tilts onto the root cause and traces the
// blast radius rack by rack, while the caption walks through what happened and
// what to do next.
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ArrowRight, RotateCcw, ShieldCheck } from 'lucide-react';
import { useSentinel } from '../../hooks/useSentinelData';
import { buildSceneModel } from '../../lib/datacenterModel';
import { STATE_HEX, createDatacenter, supportsWebGL, type Datacenter, type RackState } from '../../lib/datacenter3d';
import { nextStep } from '../../components/Lifecycle';
import { SEVERITY_LABEL } from '../../components/StatusBadge';
import { INCIDENT_STATUS_LABEL } from '../../types/domain';

const LEGEND: { state: RackState; label: string }[] = [
  { state: 'critical', label: 'Root cause' },
  { state: 'offline', label: 'Offline' },
  { state: 'degraded', label: 'Degraded' },
  { state: 'exposed', label: 'At risk' },
  { state: 'recovering', label: 'Recovering' },
];

const PHASES = ['Detected', 'Mapped', 'Next step'] as const;
const PHASE_AT = [0, 2.6, 5.0];

function prefersReducedMotion() {
  return typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
}

export function DatacenterHero() {
  const { assets, incidents, incidentAssets, effects, recoveries, assetById, myHex } = useSentinel();
  const navigate = useNavigate();
  const canvasHost = useRef<HTMLDivElement>(null);
  const labelHost = useRef<HTMLDivElement>(null);
  const engine = useRef<Datacenter | null>(null);
  const [webgl] = useState(supportsWebGL);
  const [ready, setReady] = useState(false);
  const [playedAt, setPlayedAt] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const seen = useRef<Set<string> | null>(null);
  const [spotlight, setSpotlight] = useState<string | null>(null);
  const pendingPlay = useRef(false);

  const model = useMemo(() => buildSceneModel(assets, incidents, incidentAssets, spotlight), [assets, incidents, incidentAssets, spotlight]);
  const inc = model.focusIncident;
  const modelRef = useRef(model);
  modelRef.current = model;

  // Create the engine once.
  useEffect(() => {
    if (!webgl || !canvasHost.current || !labelHost.current) return;
    let disposed = false;
    let dc: Datacenter | null = null;
    void Promise.resolve()
      .then(() =>
        createDatacenter(canvasHost.current!, labelHost.current!, {
          reducedMotion: prefersReducedMotion(),
          onPick: id => {
            const focus = modelRef.current.focusIncident;
            const inBlast = focus && incidentAssetsRef.current.some(ia => ia.incidentId === focus.incidentId && ia.assetId === id);
            navigate(inBlast ? `/incidents/${focus.incidentId}` : '/twin');
          },
        })
      )
      .then(d => {
        if (disposed) return d.dispose();
        dc = d;
        engine.current = d;
        d.setModel(modelRef.current);
        setReady(true);
      })
      .catch(() => setReady(false));
    return () => {
      disposed = true;
      dc?.dispose();
      engine.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [webgl]);
  const incidentAssetsRef = useRef(incidentAssets);
  incidentAssetsRef.current = incidentAssets;

  // Push every row change into the scene; start a queued detection once the new focus is in place.
  useEffect(() => {
    engine.current?.setModel(model);
    if (pendingPlay.current && (engine.current || !webgl)) {
      pendingPlay.current = false;
      play();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [model, ready]);

  // A newly opened incident takes the spotlight and plays the detection sequence
  // (the most urgent open incident also plays once on first view).
  useEffect(() => {
    if (!ready && webgl) return;
    const open = incidents.filter(i => i.status !== 'resolved');
    if (seen.current === null) {
      seen.current = new Set(open.map(i => String(i.incidentId)));
      if (inc) play();
      return;
    }
    const fresh = open.filter(i => !seen.current!.has(String(i.incidentId))).sort((a, b) => (a.createdAt.microsSinceUnixEpoch < b.createdAt.microsSinceUnixEpoch ? 1 : -1));
    open.forEach(i => seen.current!.add(String(i.incidentId)));
    if (fresh[0]) {
      pendingPlay.current = true;
      setSpotlight(String(fresh[0].incidentId));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [incidents, ready]);

  function play() {
    engine.current?.playDetection();
    setPlayedAt(Date.now());
  }

  // Caption clock, only while a sequence is running.
  useEffect(() => {
    if (playedAt === null) return;
    const t = window.setInterval(() => setNow(Date.now()), 250);
    const stop = window.setTimeout(() => window.clearInterval(t), (PHASE_AT[2]! + 1) * 1000);
    return () => {
      window.clearInterval(t);
      window.clearTimeout(stop);
    };
  }, [playedAt]);

  const elapsed = playedAt === null || prefersReducedMotion() ? 99 : (now - playedAt) / 1000;
  const phase = elapsed >= PHASE_AT[2]! ? 2 : elapsed >= PHASE_AT[1]! ? 1 : 0;
  const rootName = model.focus ? (assetById.get(model.focus)?.name ?? model.focus) : '';
  const step = inc ? nextStep(inc, { effects, recoveries, assetById, myHex }) : undefined;
  const flagged = model.racks.filter(r => r.state !== 'healthy').length;

  const caption = !inc
    ? `All ${assets.length} services are running. Nothing needs you right now.`
    : phase === 0
      ? `${inc.isSimulation ? 'Simulated anomaly' : 'Anomaly'} detected on ${rootName}.`
      : phase === 1
        ? `${model.affected} services mapped in the blast radius from ${rootName}.`
        : step!.text;

  return (
    <section
      className="relative h-[22rem] overflow-hidden rounded-lg border border-ink-700 bg-ink-950 sm:h-[30rem]"
      role="img"
      aria-label={`3D datacenter: ${assets.length} services in ${model.rows.length} rows, ${flagged} flagged.${inc ? ` Focus: INC-${String(inc.incidentId)} at ${rootName}.` : ''}`}
    >
      <div ref={canvasHost} className="absolute inset-0" />
      <div ref={labelHost} className="dc-labels pointer-events-none absolute inset-0 isolate overflow-hidden" />
      {!webgl && (
        <div className="absolute inset-0 grid place-items-center p-6 text-center text-sm text-slate-500">
          The 3D view needs WebGL, which this browser has turned off. The incident list below shows the same information.
        </div>
      )}
      {/* Soft vignette so the overlay text stays readable over the scene. */}
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_70%_45%,transparent_40%,rgba(17,19,23,0.75)_100%)]" aria-hidden />

      <div className="absolute top-4 left-4 z-10 w-[min(23rem,calc(100%-2rem))] rounded-lg border border-ink-700 bg-ink-900/92 p-4 backdrop-blur-sm" aria-live="polite">
        {inc ? (
          <>
            <div className="flex items-center gap-2 text-xs text-slate-400">
              <span className={`size-2 rounded-full ${inc.severity === 'critical' || inc.severity === 'high' ? 'live-pulse bg-red-500' : 'bg-amber-400'}`} aria-hidden />
              <span className="font-mono">INC-{String(inc.incidentId)}</span>
              <span>{SEVERITY_LABEL[inc.severity] ?? inc.severity} severity</span>
              <span className="text-slate-600">/</span>
              <span>{INCIDENT_STATUS_LABEL[inc.status] ?? inc.status}</span>
            </div>
            <p key={phase} className="dc-caption mt-2 text-[1.2rem] leading-snug font-medium text-slate-50">
              {caption}
            </p>
            <ol className="mt-4 grid grid-cols-3 gap-1.5" aria-label="Detection progress">
              {PHASES.map((p, i) => (
                <li key={p}>
                  <div className="h-0.5 overflow-hidden rounded-full bg-ink-700">
                    <div className={`h-full rounded-full transition-[width] duration-500 ${i < phase ? 'w-full bg-slate-400' : i === phase ? 'w-full bg-red-400' : 'w-0'}`} />
                  </div>
                  <div className={`mt-1 text-[11px] ${i === phase ? 'text-slate-200' : 'text-slate-500'}`}>{p}</div>
                </li>
              ))}
            </ol>
            <div className="mt-4 flex flex-wrap gap-2">
              {step && !step.waiting && phase === 2 ? (
                <Link to={step.to} className="btn-primary min-h-7 py-1 text-[13px]">
                  {step.cta} <ArrowRight className="size-3.5" />
                </Link>
              ) : (
                <Link to={`/incidents/${inc.incidentId}`} className="btn-primary min-h-7 py-1 text-[13px]">
                  Open incident
                </Link>
              )}
              {webgl && (
                <button type="button" className="btn-ghost min-h-7 py-1 text-[13px]" onClick={play}>
                  <RotateCcw className="size-3.5" /> Replay
                </button>
              )}
            </div>
          </>
        ) : (
          <>
            <div className="flex items-center gap-2 text-xs text-emerald-300">
              <ShieldCheck className="size-3.5" aria-hidden /> All clear
            </div>
            <p className="mt-2 text-[1.2rem] leading-snug font-medium text-slate-50">{caption}</p>
            <p className="mt-2 text-[13px] text-slate-400">Each rack is one monitored service, grouped by environment. If anything breaks, it lights up here first.</p>
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
      <div className="absolute right-4 bottom-3 hidden text-[11px] text-slate-500 sm:block">
        {model.rows.length} rows, {assets.length} services. Select a rack to open it.
      </div>
    </section>
  );
}
