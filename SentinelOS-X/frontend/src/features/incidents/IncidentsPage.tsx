import { Fragment, useMemo, useState, type ReactNode } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ArrowRight, Clock, FileSearch, Radio, Search, Siren, FlaskConical } from 'lucide-react';
import { LifecycleRail, nextStep } from '../../components/Lifecycle';
import { useSentinel } from '../../hooks/useSentinelData';
import { useAction } from '../../hooks/useAction';
import { EMPTY_INCIDENT_FILTER, chronological, filterIncidents, type IncidentFilter, type IncidentSort } from '../../lib/derive';
import { deriveBlast } from '../../lib/blast';
import { scenarioByType } from '../../lib/engine';
import { EmptyState, PageHeader, Panel } from '../../components/ui';
import { PageGate } from '../../components/PageGate';
import { RealBadge, SEVERITY_LABEL, SeverityBadge, SimBadge, StatusBadge } from '../../components/StatusBadge';
import { Timeline } from '../../components/Timeline';
import { SimulationLauncher } from '../../components/SimulationLauncher';
import { ResponseControls } from '../../components/ResponseControls';
import { BlastRadiusPanel } from './BlastRadiusPanel';
import { ScopePanel } from './ScopePanel';
import { summarizeScope } from '../../lib/scope';
import { ExportReport } from '../../components/ExportReport';
import { CAN, INCIDENT_NEXT, INCIDENT_STATUS_LABEL, type Incident, type IncidentStatus, type Role } from '../../types/domain';
import { fmtDateTime, fmtTime, humanize, relTime } from '../../lib/format';

const SEV_TONE: Record<string, string> = { info: 'text-slate-400', low: 'text-sky-300', medium: 'text-amber-300', high: 'text-red-300', critical: 'text-red-300' };

export function scenarioLabel(type: string) {
  return scenarioByType(type)?.label ?? humanize(type);
}

export function IncidentsPage() {
  return (
    <PageGate>
      <IncidentsView />
    </PageGate>
  );
}

function IncidentsView() {
  const { incidents, incidentAssets, assets } = useSentinel();
  const { incidentId } = useParams();
  const navigate = useNavigate();
  const [f, setF] = useState<IncidentFilter>(EMPTY_INCIDENT_FILTER);

  const affected = useMemo(() => {
    const m = new Map<bigint, Set<string>>();
    for (const ia of incidentAssets) {
      const s = m.get(ia.incidentId) ?? new Set<string>();
      s.add(ia.assetId);
      m.set(ia.incidentId, s);
    }
    return m;
  }, [incidentAssets]);
  const impactedNow = useMemo(() => {
    const m = new Map<bigint, number>();
    for (const ia of incidentAssets) if (ia.impactStatus !== 'recovered') m.set(ia.incidentId, (m.get(ia.incidentId) ?? 0) + 1);
    return m;
  }, [incidentAssets]);
  const list = useMemo(() => filterIncidents(incidents, affected, f), [incidents, affected, f]);
  const selected = incidentId ? incidents.find(i => String(i.incidentId) === incidentId) : list[0];
  const dirty = JSON.stringify({ ...f }) !== JSON.stringify(EMPTY_INCIDENT_FILTER);

  const openCount = incidents.filter(i => i.status !== 'resolved').length;
  return (
    <div className="space-y-5">
      <PageHeader
        title="Incidents"
        purpose={`${openCount} open, ${incidents.length - openCount} resolved. Every change here is recorded with who made it and when.`}
        actions={<SimulationLauncher compact />}
      />

      <div className="flex flex-wrap items-end gap-3" role="search" aria-label="Filter incidents">
        <label className="relative min-w-60 flex-1">
          <span className="mb-1 block text-[13px] text-slate-400">Search</span>
          <Search className="pointer-events-none absolute bottom-2.5 left-2.5 size-4 text-slate-500" aria-hidden />
          <input className="input pl-8" value={f.query} onChange={e => setF({ ...f, query: e.target.value })} placeholder="Title or INC-id" />
        </label>
        <Select label="Status" value={f.status} onChange={status => setF({ ...f, status })} options={['', 'active', 'open', 'investigating', 'contained', 'recovering', 'resolved']} labels={{ active: 'Active', ...INCIDENT_STATUS_LABEL }} />
        <Select label="Severity" value={f.severity} onChange={severity => setF({ ...f, severity })} options={['', 'low', 'medium', 'high', 'critical']} />
        <Select label="Service" value={f.assetId} onChange={assetId => setF({ ...f, assetId })} options={['', ...assets.map(a => a.assetId).sort()]} labels={Object.fromEntries(assets.map(a => [a.assetId, a.name]))} />
        <Select label="Activity" value={String(f.recentMinutes)} onChange={v => setF({ ...f, recentMinutes: Number(v) })} options={['0', '15', '60', '1440']} labels={{ '0': 'Any time', '15': 'Last 15 min', '60': 'Last hour', '1440': 'Last 24 h' }} />
        <Select label="Sort" value={f.sort} onChange={sort => setF({ ...f, sort: sort as IncidentSort })} options={['newest', 'oldest', 'severity', 'updated']} labels={{ newest: 'Newest first', oldest: 'Oldest first', severity: 'Severity', updated: 'Recently updated' }} />
        {dirty && (
          <button className="btn-ghost mb-0.5" onClick={() => setF(EMPTY_INCIDENT_FILTER)}>
            Clear filters
          </button>
        )}
      </div>

      <div className="grid gap-5 xl:grid-cols-[22rem_minmax(0,1fr)]">
        <Panel title={`Incident list (${list.length})`} bodyClass="p-0" className="xl:sticky xl:top-0 xl:self-start">
          {list.length === 0 ? (
            <EmptyState icon={Siren} title={incidents.length ? 'No incidents match these filters' : 'No active incidents. Launch a synthetic scenario to test the environment.'} />
          ) : (
            <ul className="max-h-[72vh] divide-y divide-ink-700 overflow-y-auto">
              {list.map(i => {
                const sel = selected?.incidentId === i.incidentId;
                return (
                  <li key={String(i.incidentId)}>
                    <button
                      onClick={() => navigate(`/incidents/${i.incidentId}`)}
                      className={`relative w-full px-4 py-3 text-left transition-colors ${sel ? 'bg-ink-800' : 'hover:bg-ink-850'}`}
                      aria-current={sel}
                    >
                      {sel && <span className="absolute top-0 bottom-0 left-0 w-0.5 bg-slate-200" aria-hidden />}
                      <div className="flex items-center justify-between gap-2">
                        <span className="ident">INC-{String(i.incidentId)}</span>
                        <span className="text-xs text-slate-500">{relTime(i.updatedAt)}</span>
                      </div>
                      <div className={`mt-1 line-clamp-2 text-sm font-medium ${i.status === 'resolved' ? 'text-slate-400' : 'text-slate-100'}`}>{i.title}</div>
                      <div className="mt-2 flex flex-wrap items-center gap-1.5">
                        <SeverityBadge severity={i.severity} />
                        <StatusBadge status={i.status} />
                        <span className="text-xs text-slate-500">{impactedNow.get(i.incidentId) ?? 0} impacted</span>
                      </div>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </Panel>
        {selected ? (
          <IncidentDetail incident={selected} />
        ) : incidentId ? (
          <Panel>
            <EmptyState title={`Incident ${incidentId} not found`} />
          </Panel>
        ) : null}
      </div>
    </div>
  );
}

function Select({ label, value, onChange, options, labels }: { label: string; value: string; onChange: (v: string) => void; options: string[]; labels?: Record<string, string> }) {
  return (
    <label className="flex flex-col gap-1 text-[13px] text-slate-400">
      {label}
      <select className="input w-36 py-2" value={value} onChange={e => onChange(e.target.value)} aria-label={label}>
        {options.map(o => (
          <option key={o} value={o}>
            {labels?.[o] ?? (o === '' ? 'All' : humanize(o))}
          </option>
        ))}
      </select>
    </label>
  );
}

function EvidencePanel({ incident }: { incident: Incident }) {
  const { evidence, assetById } = useSentinel();
  const rows = useMemo(() => [...evidence].filter(e => e.incidentId === incident.incidentId).sort((a, b) => (a.evidenceId < b.evidenceId ? -1 : 1)), [evidence, incident.incidentId]);
  const measured = rows.filter(e => !e.synthetic).length;
  const origin = measured === 0 ? 'Synthetic' : measured === rows.length ? 'Measured by real hardware' : 'Measured and synthetic';
  return (
    <Panel
      title={`Evidence (${rows.length})`}
      actions={<span className={`text-xs ${measured === 0 ? 'text-violet-300' : 'text-emerald-300'}`}>{origin}</span>}
      bodyClass="max-h-[50vh] overflow-y-auto p-0"
    >
      {rows.length === 0 ? (
        <EmptyState icon={FileSearch} title="No evidence recorded yet" hint="Evidence appears here as the engine, sensors or the AI investigator collect it." />
      ) : (
        <ul className="divide-y divide-ink-700" aria-label={measured === 0 ? 'Synthetic evidence' : 'Evidence'}>
          {rows.map(e => (
            <li key={String(e.evidenceId)} className="grid grid-cols-[2.6rem_minmax(0,1fr)] gap-x-3 px-4 py-3">
              <span className="pt-0.5 font-mono text-xs text-slate-500">E{String(e.evidenceId)}</span>
              <div className="min-w-0 space-y-1">
                <div className="flex flex-wrap items-baseline gap-x-2">
                  <span className="text-sm font-medium text-slate-100">{e.title}</span>
                  <span className={`text-xs ${SEV_TONE[e.severity] ?? 'text-slate-300'}`}>{SEVERITY_LABEL[e.severity] ?? e.severity}</span>
                  <span className="ml-auto font-mono text-xs text-slate-500">{fmtTime(e.observedAt)}</span>
                </div>
                <p className="text-[13px] text-slate-400">{e.detail}</p>
                <div className="flex flex-wrap gap-1 pt-0.5">
                  <span className="rounded bg-ink-800 px-1.5 py-0.5 text-[11px] text-slate-300">{assetById.get(e.assetId)?.name ?? e.assetId}</span>
                  <span className="rounded bg-ink-800 px-1.5 py-0.5 text-[11px] text-slate-400">{humanize(e.kind)}</span>
                  {!e.synthetic && <span className="rounded bg-emerald-500/12 px-1.5 py-0.5 text-[11px] text-emerald-300">measured</span>}
                  {e.indicators.map(ind => (
                    <span key={ind.key} className="rounded bg-ink-850 px-1.5 py-0.5 font-mono text-[11px] text-slate-500">
                      {ind.key}={ind.value}
                    </span>
                  ))}
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

/** The incident as a documentation record: the fields an incident report needs, in one place. */
function IncidentRecord({ incident }: { incident: Incident }) {
  const { assetById, incidentAssets, evidence, responders, dataScopes } = useSentinel();
  const scope = summarizeScope(dataScopes.filter(s => s.incidentId === incident.incidentId));
  const affected = incidentAssets.filter(ia => ia.incidentId === incident.incidentId);
  const nowImpacted = affected.filter(ia => ia.impactStatus !== 'recovered').length;
  const evCount = evidence.filter(e => e.incidentId === incident.incidentId).length;
  const ic = responders.filter(r => r.role === 'incident_commander').map(r => r.displayName);
  const rows: [string, ReactNode][] = [
    ['Incident ID', <span className="font-mono">INC-{String(incident.incidentId)}</span>],
    ['Category', scenarioLabel(incident.scenarioType)],
    ['Severity', SEVERITY_LABEL[incident.severity] ?? incident.severity],
    ['Status', INCIDENT_STATUS_LABEL[incident.status] ?? incident.status],
    ['Source', incident.isSimulation ? 'Simulation engine (synthetic)' : 'Physical sensor (real measurement)'],
    ['First affected', assetById.get(incident.initialAssetId)?.name ?? incident.initialAssetId],
    ['Services affected', `${affected.length} total, ${nowImpacted} still impacted`],
    ['Evidence items', String(evCount)],
    ['Data in scope', scope.total ? `${scope.compromised} of ${scope.total} data sets compromised${scope.notify ? `, ${scope.notify} may need notification` : ''}` : 'Not documented yet'],
    ['Detected', fmtDateTime(incident.createdAt)],
    ['Last updated', `${fmtDateTime(incident.updatedAt)} (${relTime(incident.updatedAt)})`],
    ['Resolved', incident.resolvedAt ? fmtDateTime(incident.resolvedAt) : 'Not yet'],
    ['Commanders', ic.length ? ic.join(', ') : 'None assigned'],
  ];
  return (
    <Panel title="Incident record">
      <dl className="grid grid-cols-[8.5rem_minmax(0,1fr)] gap-x-3 gap-y-2 text-[13px]">
        {rows.map(([k, v]) => (
          <Fragment key={k}>
            <dt className="text-slate-500">{k}</dt>
            <dd className="text-slate-100">{v}</dd>
          </Fragment>
        ))}
      </dl>
      {incident.resolutionSummary && (
        <div className="mt-4 rounded-md border border-emerald-500/30 bg-emerald-500/8 p-3 text-sm text-emerald-100">
          <div className="mb-0.5 text-xs font-medium text-emerald-300">Resolution summary</div>
          {incident.resolutionSummary}
        </div>
      )}
    </Panel>
  );
}

export function IncidentDetail({ incident }: { incident: Incident }) {
  const { incidentAssets, events, assetById, me, effects, dependencies, recoveries, myHex } = useSentinel();
  const { run, pending } = useAction();
  const blast = useMemo(() => deriveBlast(incident.incidentId, incidentAssets, effects, dependencies, assetById, true), [incident.incidentId, incidentAssets, effects, dependencies, assetById]);
  const timeline = useMemo(() => chronological(events.filter(e => e.incidentId === incident.incidentId)), [events, incident.incidentId]);
  const canUpdate = me ? CAN.updateIncidentStatus.includes(me.role as Role) : false;
  const next = INCIDENT_NEXT[incident.status as IncidentStatus] ?? [];
  const roots = [...new Set(effects.filter(e => e.incidentId === incident.incidentId).map(e => e.assetId))].sort();
  const step = nextStep(incident, { effects, recoveries, assetById, myHex });

  return (
    <div className="space-y-5">
      <section className="panel p-5">
        <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <span className="ident">INC-{String(incident.incidentId)}</span>
            <SeverityBadge severity={incident.severity} />
            <StatusBadge status={incident.status} />
            {incident.isSimulation ? <SimBadge /> : <RealBadge />}
          </div>
          <div className="flex flex-wrap gap-2">
            <ExportReport incidentId={incident.incidentId} />
            {incident.status !== 'resolved' && (
              <Link className="btn-ghost" to={`/lab/${incident.incidentId}`}>
                <FlaskConical className="size-4" /> Compare responses
              </Link>
            )}
            <Link className="btn-primary" to={`/command/${incident.incidentId}`}>
              <Radio className="size-4" /> Command room
            </Link>
          </div>
        </div>
        <h2 className="mt-3 text-[1.4rem] leading-snug font-semibold text-slate-50">{incident.title}</h2>
        <p className="mt-1.5 max-w-3xl text-sm text-slate-400">{incident.description}</p>

        <div className="mt-5 grid gap-x-8 gap-y-4 border-t border-ink-700 pt-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
          <div className="space-y-3">
            <LifecycleRail status={incident.status} />
            {canUpdate && next.length > 0 && (
              <div className="flex flex-wrap items-center gap-2 text-[13px] text-slate-400">
                Move to
                {next.map(s => (
                  <button key={s} className="btn-ghost min-h-7 py-0.5 text-[13px]" disabled={pending !== null} onClick={() => void run(`status-${s}`, c => c.reducers.updateIncidentStatus({ incidentId: incident.incidentId, status: s }), `Status set to ${INCIDENT_STATUS_LABEL[s] ?? s}`)}>
                    Mark {INCIDENT_STATUS_LABEL[s] ?? humanize(s)}
                  </button>
                ))}
              </div>
            )}
          </div>
          {incident.status !== 'resolved' && (
            <div className={`flex items-start gap-3 rounded-md border px-4 py-3 ${step.waiting ? 'border-ink-700 bg-ink-850' : 'border-amber-400/40 bg-amber-400/8'}`} role="note" aria-label="Next step">
              {step.waiting ? <Clock className="mt-0.5 size-4 shrink-0 text-slate-500" aria-hidden /> : <ArrowRight className="mt-0.5 size-4 shrink-0 text-amber-300" aria-hidden />}
              <div>
                <div className={`text-xs font-medium ${step.waiting ? 'text-slate-400' : 'text-amber-200'}`}>{step.waiting ? 'Waiting on someone else' : 'Next step'}</div>
                <div className="text-sm text-slate-100">{step.text}</div>
              </div>
            </div>
          )}
        </div>
      </section>

      <div className="grid gap-5 2xl:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
        <div className="space-y-5">
          <Panel title="Containment and recovery" actions={<span className="text-xs text-slate-500">Simulated actions</span>}>
            {roots.length === 0 ? (
              <p className="text-sm text-slate-500">No root-cause effects recorded for this incident.</p>
            ) : (
              <div className="space-y-3">
                {roots.map(id => (
                  <ResponseControls key={id} incident={incident} assetId={id} />
                ))}
                <p className="text-xs text-slate-500">Contain first where a containment exists. Then request recovery; a different responder approves it, and the service returns through Recovering to Healthy.</p>
              </div>
            )}
          </Panel>
          <ScopePanel incident={incident} />
          <BlastRadiusPanel incident={incident} summary={blast} />
          <EvidencePanel incident={incident} />
        </div>
        <div className="space-y-5">
          <IncidentRecord incident={incident} />
          <Panel title={`Timeline (${timeline.length} events)`} bodyClass="max-h-[70vh] overflow-y-auto px-4 py-3">
            {timeline.length ? <Timeline events={timeline} assetById={assetById} /> : <EmptyState title="No events" />}
          </Panel>
        </div>
      </div>
    </div>
  );
}
