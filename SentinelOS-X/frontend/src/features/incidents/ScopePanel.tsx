// Data scope: which data the incident touched and what state that data is in
// (exfiltrated, locked by ransomware, altered, ...). Rows live in the
// `data_scope` table; every add or change is a server-checked reducer call that
// also lands on the incident timeline and in the audit log.
import { useMemo, useState } from 'react';
import { Bell, Database, Pencil, Plus } from 'lucide-react';
import { useSentinel } from '../../hooks/useSentinelData';
import { useAction } from '../../hooks/useAction';
import { EmptyState, Field, Modal, Panel } from '../../components/ui';
import { CAN, type DataScope, type Incident, type Role } from '../../types/domain';
import { COMPROMISED, SCOPE_CATEGORY, SCOPE_CLASSIFICATION, SCOPE_STATUS, SCOPE_STATUS_ORDER, fmtRecords, scopeStatus, sortScope, summarizeScope, type ScopeStatus } from '../../lib/scope';
import { relTime } from '../../lib/format';

export function ScopeStatusBadge({ status }: { status: string }) {
  const m = scopeStatus(status);
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-[5px] px-2 py-0.5 text-xs leading-4 font-medium whitespace-nowrap ${m.bg} ${m.text}`}>
      <span className="size-1.5 rotate-45 rounded-[1px]" style={{ background: m.hex }} aria-hidden />
      {m.label}
    </span>
  );
}

function StatusPicker({ value, onChange }: { value: ScopeStatus; onChange: (s: ScopeStatus) => void }) {
  return (
    <div role="radiogroup" aria-label="What happened to this data" className="grid grid-cols-2 gap-1.5 sm:grid-cols-3">
      {SCOPE_STATUS_ORDER.map(s => {
        const m = SCOPE_STATUS[s];
        const on = s === value;
        return (
          <button
            key={s}
            type="button"
            role="radio"
            aria-checked={on}
            onClick={() => onChange(s)}
            className={`rounded-md border px-2.5 py-1.5 text-left transition-colors ${on ? 'border-slate-300 bg-ink-800' : 'border-ink-600 hover:border-slate-600 hover:bg-ink-850'}`}
          >
            <span className="flex items-center gap-1.5 text-[13px] font-medium text-slate-100">
              <span className="size-2 shrink-0 rotate-45 rounded-[1px]" style={{ background: m.hex }} aria-hidden />
              {m.label}
            </span>
            <span className="block text-[11px] leading-tight text-slate-500">{m.hint}</span>
          </button>
        );
      })}
    </div>
  );
}

function Confidence({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <div role="radiogroup" aria-label="Confidence" className="inline-flex rounded-md border border-ink-600 p-0.5">
      {(['suspected', 'confirmed'] as const).map(c => (
        <button key={c} type="button" role="radio" aria-checked={value === c} onClick={() => onChange(c)} className={`rounded px-3 py-1 text-[13px] ${value === c ? 'bg-slate-100 font-medium text-ink-950' : 'text-slate-300 hover:text-slate-50'}`}>
          {c === 'suspected' ? 'Suspected' : 'Confirmed'}
        </button>
      ))}
    </div>
  );
}

interface Draft {
  status: ScopeStatus;
  confidence: string;
  records: string;
  notify: boolean;
  notes: string;
}

const parseRecords = (s: string): bigint | null => {
  const t = s.replace(/[,\s_]/g, '');
  if (t === '') return 0n;
  return /^\d{1,13}$/.test(t) ? BigInt(t) : null;
};

function DraftFields({ d, set }: { d: Draft; set: (d: Draft) => void }) {
  return (
    <>
      {/* Not a <label>: a label forwards clicks to its first control, which would pick a status by accident. */}
      <div className="space-y-1.5">
        <span className="block text-[13px] font-medium text-slate-300">What happened to this data</span>
        <StatusPicker value={d.status} onChange={status => set({ ...d, status })} />
      </div>
      <div className="flex flex-wrap items-end gap-4">
        <div className="space-y-1.5">
          <span className="block text-[13px] font-medium text-slate-300">How sure are we</span>
          <Confidence value={d.confidence} onChange={confidence => set({ ...d, confidence })} />
        </div>
        <Field label="Records affected (estimate)" hint="Leave empty if unknown">
          <input className="input w-44" inputMode="numeric" value={d.records} onChange={e => set({ ...d, records: e.target.value })} placeholder="Unknown" aria-invalid={parseRecords(d.records) === null} />
        </Field>
      </div>
      <label className="flex items-start gap-2.5 text-sm text-slate-200">
        <input type="checkbox" className="mt-0.5 size-4 accent-amber-400" checked={d.notify} onChange={e => set({ ...d, notify: e.target.checked })} />
        <span>
          Notification may be required
          <span className="block text-xs text-slate-500">Flags this data set for Legal (regulators, customers or partners may need to be told).</span>
        </span>
      </label>
      <Field label="Notes">
        <textarea className="input" rows={2} maxLength={1000} value={d.notes} onChange={e => set({ ...d, notes: e.target.value })} placeholder="How we know, what is still unknown" />
      </Field>
    </>
  );
}

function AddScope({ incident, open, onClose }: { incident: Incident; open: boolean; onClose: () => void }) {
  const { assets, incidentAssets } = useSentinel();
  const { run, pending } = useAction();
  const involved = useMemo(() => new Set([incident.initialAssetId, ...incidentAssets.filter(ia => ia.incidentId === incident.incidentId).map(ia => ia.assetId)]), [incident, incidentAssets]);
  const sortedAssets = useMemo(() => [...assets].sort((a, b) => Number(involved.has(b.assetId)) - Number(involved.has(a.assetId)) || a.name.localeCompare(b.name)), [assets, involved]);
  const [assetId, setAssetId] = useState(incident.initialAssetId);
  const [dataSet, setDataSet] = useState('');
  const [category, setCategory] = useState('pii');
  const [classification, setClassification] = useState('confidential');
  const [d, setD] = useState<Draft>({ status: 'under_review', confidence: 'suspected', records: '', notify: false, notes: '' });
  const records = parseRecords(d.records);
  const valid = dataSet.trim().length >= 3 && records !== null;

  const save = async () => {
    if (records === null) return;
    const ok = await run(
      'scope-add',
      c => c.reducers.recordDataScope({ incidentId: incident.incidentId, assetId, dataSet, category, classification, recordEstimate: records, status: d.status, confidence: d.confidence, notificationRequired: d.notify, notes: d.notes }),
      'Added to data scope'
    );
    if (ok) {
      setDataSet('');
      setD({ status: 'under_review', confidence: 'suspected', records: '', notify: false, notes: '' });
      onClose();
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Add data to scope"
      wide
      footer={
        <>
          <button className="btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn-primary" disabled={!valid || pending !== null} onClick={() => void save()}>
            Add to scope
          </button>
        </>
      }
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Data set">
          <input className="input" value={dataSet} onChange={e => setDataSet(e.target.value)} maxLength={120} placeholder="Customer account records" />
        </Field>
        <Field label="Where it lives">
          <select className="input" value={assetId} onChange={e => setAssetId(e.target.value)} aria-label="Where it lives">
            {sortedAssets.map(a => (
              <option key={a.assetId} value={a.assetId}>
                {a.name}
                {involved.has(a.assetId) ? ' (in this incident)' : ''}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Kind of data">
          <select className="input" value={category} onChange={e => setCategory(e.target.value)} aria-label="Kind of data">
            {Object.entries(SCOPE_CATEGORY).map(([k, l]) => (
              <option key={k} value={k}>
                {l}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Classification">
          <select className="input" value={classification} onChange={e => setClassification(e.target.value)} aria-label="Classification">
            {Object.entries(SCOPE_CLASSIFICATION).map(([k, l]) => (
              <option key={k} value={k}>
                {l}
              </option>
            ))}
          </select>
        </Field>
      </div>
      <DraftFields d={d} set={setD} />
    </Modal>
  );
}

function ScopeRow({ row, canEdit }: { row: DataScope; canEdit: boolean }) {
  const { assetById } = useSentinel();
  const { run, pending } = useAction();
  const [editing, setEditing] = useState(false);
  const [d, setD] = useState<Draft>({ status: row.status as ScopeStatus, confidence: row.confidence, records: row.recordEstimate === 0n ? '' : String(row.recordEstimate), notify: row.notificationRequired, notes: row.notes });
  const records = parseRecords(d.records);
  const m = scopeStatus(row.status);
  const startEdit = () => {
    setD({ status: row.status as ScopeStatus, confidence: row.confidence, records: row.recordEstimate === 0n ? '' : String(row.recordEstimate), notify: row.notificationRequired, notes: row.notes });
    setEditing(true);
  };
  const save = async () => {
    if (records === null) return;
    const ok = await run(
      `scope-${row.scopeId}`,
      c => c.reducers.updateDataScope({ scopeId: row.scopeId, status: d.status, confidence: d.confidence, recordEstimate: records, notificationRequired: d.notify, notes: d.notes }),
      'Data scope updated'
    );
    if (ok) setEditing(false);
  };

  return (
    <li className="relative px-4 py-3.5" aria-label={`Scope: ${row.dataSet}`}>
      <span className="absolute top-3.5 bottom-3.5 left-0 w-[3px] rounded-r" style={{ background: m.hex }} aria-hidden />
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[15px] font-semibold text-slate-50">{row.dataSet}</span>
            <ScopeStatusBadge status={row.status} />
            <span className={`rounded-[5px] border px-1.5 py-px text-xs ${row.confidence === 'confirmed' ? 'border-slate-400 text-slate-200' : 'border-dashed border-slate-600 text-slate-400'}`}>{row.confidence === 'confirmed' ? 'Confirmed' : 'Suspected'}</span>
            {row.notificationRequired && (
              <span className="inline-flex items-center gap-1 rounded-[5px] bg-amber-500/14 px-1.5 py-px text-xs text-amber-200">
                <Bell className="size-3" aria-hidden /> Notification likely
              </span>
            )}
          </div>
          <div className="text-[13px] text-slate-400">
            {assetById.get(row.assetId)?.name ?? row.assetId}, {SCOPE_CATEGORY[row.category] ?? row.category}, {SCOPE_CLASSIFICATION[row.classification] ?? row.classification}
            {m.cia && <span className="text-slate-500">. {m.cia} impact</span>}
          </div>
          {row.notes && !editing && <p className="max-w-2xl text-[13px] text-slate-300">{row.notes}</p>}
        </div>
        <div className="flex shrink-0 items-start gap-4">
          <div className="text-right">
            <div className="text-xs text-slate-500">Records</div>
            <div className="text-base font-semibold text-slate-100 tabular-nums">{fmtRecords(row.recordEstimate)}</div>
          </div>
          {canEdit && !editing && (
            <button className="btn-ghost min-h-7 px-2 py-1 text-[13px]" onClick={startEdit} aria-label={`Update ${row.dataSet}`}>
              <Pencil className="size-3.5" /> Update
            </button>
          )}
        </div>
      </div>
      <div className="mt-1.5 text-xs text-slate-500">
        {row.source === 'engine' ? 'Suggested by the simulation engine' : `Added by ${row.createdByName}`}
        {row.updatedAt.microsSinceUnixEpoch !== row.createdAt.microsSinceUnixEpoch && `. Last updated by ${row.updatedByName}`} {relTime(row.updatedAt)}.
      </div>
      {editing && (
        <div className="mt-3 space-y-3 rounded-md border border-ink-600 bg-ink-950/50 p-3">
          <DraftFields d={d} set={setD} />
          <div className="flex justify-end gap-2">
            <button className="btn-ghost" onClick={() => setEditing(false)}>
              Cancel
            </button>
            <button className="btn-primary" disabled={records === null || pending !== null} onClick={() => void save()}>
              Save changes
            </button>
          </div>
        </div>
      )}
    </li>
  );
}

export function ScopePanel({ incident }: { incident: Incident }) {
  const { dataScopes, me } = useSentinel();
  const [adding, setAdding] = useState(false);
  const rows = useMemo(() => sortScope(dataScopes.filter(s => s.incidentId === incident.incidentId)), [dataScopes, incident.incidentId]);
  const sum = summarizeScope(rows);
  const canEdit = !!me && CAN.recordScope.includes(me.role as Role);
  const shown = SCOPE_STATUS_ORDER.filter(s => (sum.byStatus[s] ?? 0) > 0);

  return (
    <Panel
      title="Data scope"
      actions={
        canEdit ? (
          <button className="btn-ghost min-h-7 py-1 text-[13px]" onClick={() => setAdding(true)}>
            <Plus className="size-3.5" /> Add data
          </button>
        ) : (
          <span className="text-xs text-slate-500">{me ? 'Commanders, analysts and legal can edit' : 'Join the team to edit'}</span>
        )
      }
      bodyClass="p-0"
    >
      {rows.length === 0 ? (
        <EmptyState icon={Database} title="No data recorded in scope yet." hint="Add each data set this incident may have touched, even if you are not sure yet. Mark it suspected and confirm later." />
      ) : (
        <>
          <div className="grid grid-cols-2 border-b border-ink-700 sm:grid-cols-4" role="group" aria-label="Data scope summary">
            <div className="px-4 py-3">
              <div className="text-[13px] text-slate-400">Data sets compromised</div>
              <div className={`text-[1.4rem] leading-tight font-semibold tabular-nums ${sum.compromised ? 'text-red-300' : 'text-slate-200'}`}>
                {sum.compromised}
                <span className="text-sm font-normal text-slate-500"> of {sum.total}</span>
              </div>
            </div>
            <div className="px-4 py-3">
              <div className="text-[13px] text-slate-400">Records at risk</div>
              <div className="text-[1.4rem] leading-tight font-semibold text-slate-100 tabular-nums">{sum.records > 0n ? Number(sum.records).toLocaleString() : '—'}</div>
              {sum.unknownCounts > 0 && <div className="text-xs text-slate-500">+{sum.unknownCounts} with unknown count</div>}
            </div>
            <div className="px-4 py-3">
              <div className="text-[13px] text-slate-400">Confirmed</div>
              <div className="text-[1.4rem] leading-tight font-semibold text-slate-100 tabular-nums">
                {sum.confirmed}
                <span className="text-sm font-normal text-slate-500"> of {sum.total}</span>
              </div>
            </div>
            <div className="px-4 py-3">
              <div className="text-[13px] text-slate-400">Notification likely</div>
              <div className={`text-[1.4rem] leading-tight font-semibold tabular-nums ${sum.notify ? 'text-amber-200' : 'text-slate-200'}`}>{sum.notify}</div>
            </div>
          </div>
          <div className="flex flex-wrap gap-1.5 border-b border-ink-700 px-4 py-2.5" aria-label="Data sets by status">
            {shown.map(s => (
              <span key={s} className="inline-flex items-center gap-1.5 text-xs text-slate-300">
                <ScopeStatusBadge status={s} />
                <span className="tabular-nums">{sum.byStatus[s]}</span>
              </span>
            ))}
            {COMPROMISED.every(s => !sum.byStatus[s]) && <span className="text-xs text-emerald-300">No data currently compromised.</span>}
          </div>
          <ul className="divide-y divide-ink-700">
            {rows.map(r => (
              <ScopeRow key={String(r.scopeId)} row={r} canEdit={canEdit} />
            ))}
          </ul>
        </>
      )}
      {canEdit && <AddScope key={String(incident.incidentId)} incident={incident} open={adding} onClose={() => setAdding(false)} />}
    </Panel>
  );
}
