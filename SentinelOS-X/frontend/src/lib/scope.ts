// Display vocabulary for data-compromise scope. Keys mirror the values the
// SpacetimeDB module validates (spacetime/src/scope.ts); a test keeps them in sync.
import type { DataScope } from '../types/domain';

export type ScopeStatus = 'under_review' | 'accessed' | 'exfiltrated' | 'encrypted' | 'altered' | 'destroyed' | 'secured' | 'restored' | 'not_affected';
export type Cia = 'Confidentiality' | 'Integrity' | 'Availability';

export const SCOPE_STATUS: Record<ScopeStatus, { label: string; hint: string; cia?: Cia; text: string; bg: string; hex: string }> = {
  exfiltrated: { label: 'Exfiltrated', hint: 'Copied out of the environment', cia: 'Confidentiality', text: 'text-red-200', bg: 'bg-red-500/16', hex: '#f0524f' },
  encrypted: { label: 'Locked by ransomware', hint: 'Encrypted and unusable', cia: 'Availability', text: 'text-red-200', bg: 'bg-red-500/16', hex: '#f0524f' },
  destroyed: { label: 'Destroyed', hint: 'Deleted or wiped', cia: 'Availability', text: 'text-red-200', bg: 'bg-red-500/16', hex: '#f0524f' },
  altered: { label: 'Altered', hint: 'Modified or tampered with', cia: 'Integrity', text: 'text-orange-200', bg: 'bg-orange-500/16', hex: '#fb923c' },
  accessed: { label: 'Accessed', hint: 'Viewed without authorization', cia: 'Confidentiality', text: 'text-amber-200', bg: 'bg-amber-500/14', hex: '#fbbf24' },
  under_review: { label: 'Under review', hint: 'Impact not known yet', text: 'text-slate-200', bg: 'bg-slate-500/16', hex: '#969da8' },
  secured: { label: 'Secured', hint: 'Access cut off and contained', text: 'text-cyan-200', bg: 'bg-cyan-500/14', hex: '#6fa3f6' },
  restored: { label: 'Restored', hint: 'Back to a known-good copy', text: 'text-emerald-300', bg: 'bg-emerald-500/12', hex: '#3db37a' },
  not_affected: { label: 'Not affected', hint: 'Checked and ruled out', text: 'text-emerald-300', bg: 'bg-emerald-500/12', hex: '#3db37a' },
};

/** Worst first. Also the order of the status picker. */
export const SCOPE_STATUS_ORDER = Object.keys(SCOPE_STATUS) as ScopeStatus[];

/** Statuses that mean data is still compromised. */
export const COMPROMISED: readonly ScopeStatus[] = ['exfiltrated', 'encrypted', 'destroyed', 'altered', 'accessed'];

export const SCOPE_CATEGORY: Record<string, string> = {
  pii: 'Personal data (PII)',
  credentials: 'Credentials and secrets',
  financial: 'Financial',
  health: 'Health records',
  intellectual_property: 'Intellectual property',
  operational: 'Operational / system data',
  logs: 'Logs and telemetry',
  other: 'Other',
};

export const SCOPE_CLASSIFICATION: Record<string, string> = {
  public: 'Public',
  internal: 'Internal',
  confidential: 'Confidential',
  restricted: 'Restricted',
};

export const scopeStatus = (s: string) => SCOPE_STATUS[s as ScopeStatus] ?? SCOPE_STATUS.under_review;

export function sortScope(rows: readonly DataScope[]): DataScope[] {
  const rank = (s: string) => {
    const i = SCOPE_STATUS_ORDER.indexOf(s as ScopeStatus);
    return i < 0 ? 99 : i;
  };
  return [...rows].sort((a, b) => rank(a.status) - rank(b.status) || (a.scopeId < b.scopeId ? -1 : 1));
}

export interface ScopeSummary {
  total: number;
  compromised: number;
  byStatus: Partial<Record<ScopeStatus, number>>;
  /** Sum of known record estimates for data that is still compromised. */
  records: bigint;
  unknownCounts: number;
  notify: number;
  confirmed: number;
}

export function summarizeScope(rows: readonly DataScope[]): ScopeSummary {
  const s: ScopeSummary = { total: rows.length, compromised: 0, byStatus: {}, records: 0n, unknownCounts: 0, notify: 0, confirmed: 0 };
  for (const r of rows) {
    const st = r.status as ScopeStatus;
    s.byStatus[st] = (s.byStatus[st] ?? 0) + 1;
    if (COMPROMISED.includes(st)) {
      s.compromised++;
      if (r.recordEstimate > 0n) s.records += r.recordEstimate;
      else s.unknownCounts++;
    }
    if (r.notificationRequired) s.notify++;
    if (r.confidence === 'confirmed') s.confirmed++;
  }
  return s;
}

export const fmtRecords = (n: bigint) => (n === 0n ? 'Unknown' : Number(n).toLocaleString());
