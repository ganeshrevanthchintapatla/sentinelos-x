import { Link, NavLink, Outlet } from 'react-router-dom';
import { useSpacetimeDB } from 'spacetimedb/react';
import { useEffect, useMemo, useState } from 'react';
import { Bot, FlaskConical, Fingerprint, Gauge, Network, PlayCircle, Radio, RefreshCw, ShieldCheck, Siren, Users, type LucideIcon } from 'lucide-react';
import { useSentinel } from '../hooks/useSentinelData';
import { ROLE_LABEL, SEVERITY_RANK, type Role } from '../types/domain';
import { SPACETIMEDB_DB_NAME, SPACETIMEDB_HOST } from '../services/spacetime';
import { ErrorBanner } from './ui';
import { RegisterPanel } from './RegisterPanel';
import { LifecycleRail, nextStep } from './Lifecycle';

export interface NavItem {
  to: string;
  label: string;
  icon: LucideIcon;
  end?: boolean;
}

// Grouped by the job a responder is doing, in the order they usually need it.
export const NAV: { group: string; items: NavItem[] }[] = [
  {
    group: 'Respond',
    items: [
      { to: '/', label: 'Live demo', icon: PlayCircle, end: true },
      { to: '/overview', label: 'Operations', icon: Gauge, end: true },
      { to: '/incidents', label: 'Incidents', icon: Siren },
      { to: '/command', label: 'Command room', icon: Radio },
    ],
  },
  {
    group: 'Analyze',
    items: [
      { to: '/twin', label: 'Digital twin', icon: Network },
      { to: '/ai', label: 'AI investigator', icon: Bot },
      { to: '/lab', label: 'Decision lab', icon: FlaskConical },
    ],
  },
  { group: 'Administer', items: [{ to: '/settings', label: 'People & access', icon: Users }] },
];
export const FLAT_NAV = NAV.flatMap(g => g.items);

/** Logo and product name at the top of the sidebar (shared with the demo shell). */
export function SidebarBrand() {
  return (
    <div className="flex items-center gap-2.5 px-5 pt-5 pb-4">
      <svg viewBox="0 0 24 24" className="size-6 shrink-0" aria-hidden>
        <path d="M12 2.5 4 5.5v6.1c0 4.7 3.3 8.7 8 9.9 4.7-1.2 8-5.2 8-9.9V5.5l-8-3Z" fill="none" stroke="currentColor" strokeWidth="1.6" className="text-slate-300" />
        <path d="M12 7v6.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="text-red-400" />
        <circle cx="12" cy="16.5" r="1.2" className="fill-red-400" />
      </svg>
      <div className="leading-tight">
        <div className="text-[15px] font-semibold text-slate-50">SentinelOS X</div>
        <div className="text-xs text-slate-500">Incident command</div>
      </div>
    </div>
  );
}

function useNow(ms: number) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), ms);
    return () => window.clearInterval(t);
  }, [ms]);
  return now;
}

function ConnectionPill() {
  const { isActive, connectionError } = useSpacetimeDB();
  const { ready } = useSentinel();
  const [cls, dot, label, title] =
    isActive && ready
      ? ['text-emerald-300', 'bg-emerald-400', 'Live', `${SPACETIMEDB_HOST} / ${SPACETIMEDB_DB_NAME}`]
      : isActive
        ? ['text-amber-200', 'bg-amber-400 live-pulse', 'Syncing', 'Applying subscriptions']
        : ['text-red-200', 'bg-red-400 live-pulse', 'Offline', connectionError?.message ?? 'Disconnected'];
  return (
    <span className={`inline-flex items-center gap-2 text-[13px] font-medium ${cls}`} title={title}>
      <span className={`size-2 rounded-full ${dot}`} aria-hidden />
      {label}
    </span>
  );
}

/**
 * The always-visible situation bar: the most urgent open incident, where it is
 * in its lifecycle and the one thing to do next. Responders never need to
 * hunt for "what now".
 */
function SituationBar() {
  const { incidents, effects, recoveries, assetById, myHex } = useSentinel();
  const active = useMemo(
    () =>
      incidents
        .filter(i => i.status !== 'resolved')
        .sort((a, b) => (SEVERITY_RANK[b.severity] ?? 0) - (SEVERITY_RANK[a.severity] ?? 0) || (a.createdAt.microsSinceUnixEpoch < b.createdAt.microsSinceUnixEpoch ? 1 : -1)),
    [incidents]
  );
  const top = active[0];
  if (!top) {
    return (
      <div className="flex min-w-0 items-center gap-2 text-[13px] text-slate-400">
        <ShieldCheck className="size-4 text-emerald-400" aria-hidden />
        No open incidents.
      </div>
    );
  }
  const step = nextStep(top, { effects, recoveries, assetById, myHex });
  const sevTone = top.severity === 'critical' || top.severity === 'high' ? 'bg-red-500' : top.severity === 'medium' ? 'bg-amber-400' : 'bg-sky-400';
  return (
    <div className="flex min-w-0 flex-1 items-center gap-4" aria-label="Most urgent open incident">
      <Link to={`/incidents/${top.incidentId}`} className="group flex min-w-0 items-center gap-2.5">
        <span className={`h-6 w-1 shrink-0 rounded-full ${sevTone}`} aria-hidden />
        <span className="ident shrink-0">INC-{String(top.incidentId)}</span>
        <span className="truncate text-sm font-medium text-slate-100 group-hover:underline">{top.title}</span>
      </Link>
      <div className="hidden shrink-0 lg:block">
        <LifecycleRail status={top.status} size="sm" />
      </div>
      <Link
        to={step.to}
        className={`hidden shrink-0 items-center gap-1.5 rounded-md px-2.5 py-1 text-[13px] font-medium xl:inline-flex ${step.waiting ? 'text-slate-400 hover:text-slate-200' : 'bg-slate-100 text-ink-950 hover:bg-white'}`}
        title={step.text}
      >
        {step.waiting ? 'Waiting: ' : 'Next: '}
        {step.cta}
      </Link>
      {active.length > 1 && (
        <Link to="/incidents" className="hidden shrink-0 text-[13px] text-slate-400 hover:text-slate-200 md:inline">
          +{active.length - 1} more open
        </Link>
      )}
    </div>
  );
}

/** Live status of each connected service principal (agent, gateway, telemetry). */
function ServiceList() {
  const { services, simulation } = useSentinel();
  const now = useNow(4000);
  const row = (label: string, state: string, tone: string) => (
    <li key={label} className="flex items-center justify-between gap-2">
      <span className="truncate text-slate-400">{label}</span>
      <span className={`shrink-0 ${tone}`}>{state}</span>
    </li>
  );
  const svc = (kind: string, label: string) => {
    const s = services.find(x => x.kind === kind && x.status !== 'revoked');
    // The sensor gateway talks over short HTTP calls, so `online` is only true during a call.
    const recentHttp = kind === 'hardware_gateway' && !!s && now - Number(s.lastSeenAt.microsSinceUnixEpoch / 1000n) < 20_000;
    const state = !s ? 'not connected' : s.status === 'pending' ? 'needs approval' : s.online || recentHttp ? 'online' : 'offline';
    const tone = state === 'online' ? 'text-emerald-300' : state === 'needs approval' ? 'text-amber-300' : 'text-slate-600';
    return row(label, state, tone);
  };
  const last = simulation?.lastTickAt?.toDate().getTime();
  const stale = !simulation || !last || now - last > simulation.intervalMs * 3 + 2000;
  return (
    <ul className="space-y-1 text-xs" aria-label="Connected services">
      {svc('ai_agent', 'Nemotron agent')}
      {svc('hardware_gateway', 'Sensor gateway')}
      {services.some(x => x.kind === 'telemetry') && svc('telemetry', 'External telemetry')}
      {row(
        'Simulation engine',
        !simulation ? 'not started' : !simulation.telemetryEnabled ? 'paused' : stale ? 'waiting' : `tick ${String(simulation.tickCount)}`,
        !simulation || stale ? 'text-slate-600' : 'text-slate-300'
      )}
    </ul>
  );
}

export function AppShell() {
  const { isActive, connectionError, identity } = useSpacetimeDB();
  const { me, incidents, ready, recoveries, myHex } = useSentinel();
  const activeCount = incidents.filter(i => i.status !== 'resolved').length;
  const awaitingMe = recoveries.filter(r => r.status === 'pending' && r.requestedBy.toHexString() !== myHex).length;
  const badge = (to: string) => (to === '/incidents' ? activeCount : to === '/command' ? awaitingMe : 0);
  const badgeTone = (to: string) => (to === '/incidents' ? 'bg-red-500/20 text-red-200' : 'bg-amber-500/20 text-amber-200');
  const badgeLabel = (to: string, n: number) => (to === '/incidents' ? `${n} open incidents` : `${n} approvals waiting`);

  return (
    <div className="flex h-full">
      <aside className="hidden w-60 shrink-0 flex-col border-r border-ink-700 bg-ink-900 md:flex">
        <SidebarBrand />

        <nav className="flex-1 space-y-5 overflow-y-auto px-3 pt-2" aria-label="Main">
          {NAV.map(g => (
            <div key={g.group}>
              <div className="px-2 pb-1.5 text-xs font-medium text-slate-600">{g.group}</div>
              <ul className="space-y-0.5">
                {g.items.map(n => {
                  const count = badge(n.to);
                  return (
                    <li key={n.to}>
                      <NavLink
                        to={n.to}
                        end={n.end}
                        className={({ isActive: a }) =>
                          `relative flex items-center gap-2.5 rounded-md px-2.5 py-2 text-sm transition-colors ${a ? 'bg-ink-800 font-medium text-slate-50 before:absolute before:top-2 before:bottom-2 before:-left-3 before:w-0.5 before:rounded-full before:bg-slate-200' : 'text-slate-400 hover:bg-ink-850 hover:text-slate-200'}`
                        }
                      >
                        <n.icon className="size-4 shrink-0" aria-hidden />
                        <span className="flex-1">{n.label}</span>
                        {count > 0 && (
                          <span className={`rounded px-1.5 text-xs font-semibold tabular-nums ${badgeTone(n.to)}`} aria-label={badgeLabel(n.to, count)}>
                            {count}
                          </span>
                        )}
                      </NavLink>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </nav>

        <div className="space-y-4 border-t border-ink-700 px-5 py-4">
          <ServiceList />
          <div className="space-y-1.5 text-xs text-slate-500">
            <div className="flex items-center gap-1.5 text-slate-300">
              <ShieldCheck className="size-3.5 text-emerald-400" aria-hidden /> Isolated mode
            </div>
            <p className="leading-relaxed">
              This browser talks only to <span className="ident text-[11px]">{SPACETIMEDB_HOST.replace(/^wss?:\/\//, '')}</span>. Every action is checked by the server against your role. Recovery needs two people.
            </p>
          </div>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 shrink-0 items-center gap-4 border-b border-ink-700 bg-ink-900 px-4 lg:px-6">
          <nav className="flex gap-0.5 md:hidden" aria-label="Main (mobile)">
            {FLAT_NAV.map(n => (
              <NavLink key={n.to} to={n.to} end={n.end} className={({ isActive: a }) => `rounded-md p-2 ${a ? 'bg-ink-800 text-slate-50' : 'text-slate-400'}`} aria-label={n.label}>
                <n.icon className="size-4" />
              </NavLink>
            ))}
          </nav>
          <div className="hidden min-w-0 flex-1 md:flex">{ready ? <SituationBar /> : <span className="text-[13px] text-slate-500">Loading live state…</span>}</div>
          <div className="ml-auto flex shrink-0 items-center gap-4">
            <ConnectionPill />
            <span className="h-5 w-px bg-ink-700" aria-hidden />
            {me ? (
              <span className="flex items-center gap-2 text-[13px]">
                <span className="grid size-7 place-items-center rounded-full bg-ink-800 text-xs font-semibold text-slate-200" aria-hidden>
                  {me.displayName.slice(0, 1).toUpperCase()}
                </span>
                <span className="hidden leading-tight sm:block">
                  <span className="block font-medium text-slate-100">{me.displayName}</span>
                  <span className="block text-xs text-slate-400">{ROLE_LABEL[me.role as Role] ?? me.role}</span>
                </span>
              </span>
            ) : (
              <span className="text-[13px] text-slate-500">Not signed in</span>
            )}
            {identity && (
              <span className="hidden items-center gap-1 text-slate-600 xl:inline-flex" title="Your session identity in this tab. It proves continuity, not who you are.">
                <Fingerprint className="size-3.5" aria-hidden />
                <span className="ident text-[11px] text-slate-600">{identity.toHexString().slice(0, 8)}</span>
              </span>
            )}
          </div>
        </header>

        <main className="min-h-0 flex-1 overflow-y-auto px-4 py-6 lg:px-8">
          <div className="mx-auto max-w-[1520px] space-y-5">
            {!isActive && (
              <div className="flex flex-wrap items-start gap-3">
                <div className="min-w-64 flex-1">
                  <ErrorBanner
                    title="Connection to SpacetimeDB lost. Live actions are unavailable until reconnection."
                    detail={`${connectionError?.message ?? 'Attempting to connect'}. Server: ${SPACETIMEDB_HOST} / ${SPACETIMEDB_DB_NAME}. Data on screen may be stale; the client keeps retrying.`}
                  />
                </div>
                <button className="btn-ghost" onClick={() => window.location.reload()}>
                  <RefreshCw className="size-4" /> Retry now
                </button>
              </div>
            )}
            {isActive && ready && !me && <RegisterPanel />}
            <Outlet />
          </div>
        </main>
      </div>
    </div>
  );
}
