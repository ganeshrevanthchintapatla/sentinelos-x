// The incident lifecycle rail and the "what to do next" guidance.
//
// Responders under stress should never have to remember the process: every
// incident shows where it is in the lifecycle (aligned with NIST SP 800-61:
// detection & analysis → containment → recovery → post-incident) and the one
// action that moves it forward. Both are derived from server rows; nothing here
// writes state.
import type { Asset, Incident, IncidentEffect, RecoveryAction } from '../types/domain';
import { CONTAINMENT, type EffectKind } from '../lib/engine';

export const LIFECYCLE = [
  { status: 'open', label: 'Detected' },
  { status: 'investigating', label: 'Investigating' },
  { status: 'contained', label: 'Contained' },
  { status: 'recovering', label: 'Recovering' },
  { status: 'resolved', label: 'Resolved' },
] as const;

/** Text colour for each lifecycle phase. Red → amber → blue → sky → green. */
export const PHASE_TEXT: Record<string, string> = {
  open: 'text-red-300',
  investigating: 'text-amber-300',
  contained: 'text-cyan-300',
  recovering: 'text-sky-300',
  resolved: 'text-emerald-300',
};
const PHASE_BAR: Record<string, string> = {
  open: 'bg-red-400',
  investigating: 'bg-amber-400',
  contained: 'bg-cyan-400',
  recovering: 'bg-sky-400',
  resolved: 'bg-emerald-400',
};

export function LifecycleRail({ status, size = 'md' }: { status: string; size?: 'sm' | 'md' }) {
  const at = Math.max(
    0,
    LIFECYCLE.findIndex(p => p.status === status)
  );
  const current = LIFECYCLE[at]!;
  if (size === 'sm') {
    return (
      <div className="flex items-center gap-2" role="img" aria-label={`Lifecycle: ${current.label} (step ${at + 1} of ${LIFECYCLE.length})`}>
        <div className="flex gap-0.5">
          {LIFECYCLE.map((p, i) => (
            <span key={p.status} className={`h-1.5 w-4 rounded-full ${i < at ? 'bg-slate-500' : i === at ? PHASE_BAR[status] : 'bg-ink-700'}`} />
          ))}
        </div>
        <span className={`text-xs font-medium ${PHASE_TEXT[status] ?? 'text-slate-300'}`}>{current.label}</span>
      </div>
    );
  }
  return (
    <ol className="grid grid-cols-5 gap-1" aria-label="Incident lifecycle">
      {LIFECYCLE.map((p, i) => {
        const state = i < at ? 'done' : i === at ? 'current' : 'next';
        return (
          <li key={p.status} aria-current={state === 'current' ? 'step' : undefined} className="min-w-0">
            <div className={`h-1 rounded-full ${state === 'done' ? 'bg-slate-500' : state === 'current' ? PHASE_BAR[status] : 'bg-ink-700'}`} />
            <div className={`mt-1.5 truncate text-xs ${state === 'current' ? `font-semibold ${PHASE_TEXT[status]}` : state === 'done' ? 'text-slate-400' : 'text-slate-600'}`}>{p.label}</div>
          </li>
        );
      })}
    </ol>
  );
}

export interface NextStep {
  /** Plain-language instruction, written as what the responder should do. */
  text: string;
  /** Short button label (an imperative verb). */
  cta: string;
  to: string;
  /** True when the next move belongs to someone else (show as waiting, not as a call to action). */
  waiting?: boolean;
}

export function nextStep(
  incident: Incident,
  ctx: { effects: readonly IncidentEffect[]; recoveries: readonly RecoveryAction[]; assetById: Map<string, Asset>; myHex?: string }
): NextStep {
  const id = String(incident.incidentId);
  const name = (assetId: string) => ctx.assetById.get(assetId)?.name ?? assetId;
  if (incident.status === 'resolved') return { text: 'Resolved. Export the report for the record and review the timeline.', cta: 'Open report', to: `/incidents/${id}` };

  const pending = ctx.recoveries.find(r => r.incidentId === incident.incidentId && r.status === 'pending');
  if (pending) {
    if (ctx.myHex && pending.requestedBy.toHexString() === ctx.myHex)
      return { text: `You requested recovery of ${name(pending.assetId)}. A second responder must approve it.`, cta: 'Open command room', to: `/command/${id}`, waiting: true };
    return { text: `Approve or reject the recovery of ${name(pending.assetId)}.`, cta: 'Review recovery', to: `/command/${id}` };
  }

  const mine = ctx.effects.filter(e => e.incidentId === incident.incidentId);
  const containable = mine.find(e => e.phase === 'active' && CONTAINMENT[e.kind as EffectKind]);
  if (containable) {
    const label = CONTAINMENT[containable.kind as EffectKind]!.label;
    return { text: `Contain ${name(containable.assetId)}: ${label.charAt(0).toLowerCase()}${label.slice(1)}.`, cta: 'Contain', to: `/incidents/${id}` };
  }

  const unrecovered = mine.find(e => e.phase === 'active' || e.phase === 'contained');
  if (unrecovered) return { text: `Request recovery of ${name(unrecovered.assetId)}. A second responder approves it.`, cta: 'Request recovery', to: `/incidents/${id}` };

  const restoring = mine.find(e => e.phase === 'recovering');
  if (restoring) return { text: `${name(restoring.assetId)} is being restored. It returns to healthy within a few seconds.`, cta: 'Watch', to: `/incidents/${id}`, waiting: true };

  return { text: 'Every affected service is back. Write the resolution summary and close the incident.', cta: 'Resolve', to: `/command/${id}` };
}
