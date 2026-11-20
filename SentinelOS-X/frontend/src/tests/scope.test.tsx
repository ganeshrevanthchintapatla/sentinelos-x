// Data-compromise scope in the UI: vocabulary matches the server, summaries are
// computed from rows, the panel respects roles, and the report includes scope.
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { Identity, Timestamp } from 'spacetimedb';
import { loadScenario, scenarioIdentityHex } from './fixtures/load';
import { SentinelDataContext, type SentinelData } from '../hooks/useSentinelData';
import { ToastProvider } from '../components/Toast';
import { ScopePanel } from '../features/incidents/ScopePanel';
import { SCOPE_CATEGORY, SCOPE_CLASSIFICATION, SCOPE_STATUS, summarizeScope } from '../lib/scope';
import { buildIncidentReport } from '../lib/report';
import * as server from '../../../spacetime/src/scopeVocab';
import type { DataScope } from '../types/domain';

vi.mock('spacetimedb/react', () => ({
  useSpacetimeDB: () => ({ isActive: true, identity: Identity.fromString(scenarioIdentityHex), connectionError: undefined, getConnection: () => null }),
  useTable: () => [[], true],
}));

const ts = (s: number) => new Timestamp(1_700_000_000_000_000n + BigInt(s) * 1_000_000n);

function row(over: Partial<DataScope> & Pick<DataScope, 'scopeId' | 'incidentId'>): DataScope {
  return {
    assetId: 'primary-db',
    dataSet: 'Customer account records',
    category: 'pii',
    classification: 'restricted',
    recordEstimate: 0n,
    status: 'under_review',
    confidence: 'suspected',
    notificationRequired: false,
    notes: '',
    source: 'responder',
    createdBy: undefined,
    createdByName: 'Ada (IC)',
    createdAt: ts(0),
    updatedByName: 'Ada (IC)',
    updatedAt: ts(0),
    ...over,
  };
}

function withScope(rows: (incidentId: bigint) => DataScope[]) {
  const d = loadScenario();
  const db = d.incidents.find(i => i.scenarioType === 'database_outage')!;
  return { d: { ...d, dataScopes: rows(db.incidentId) } as SentinelData, db };
}

const sample = (id: bigint) => [
  row({ scopeId: 1n, incidentId: id, dataSet: 'Payment card tokens', category: 'financial', status: 'exfiltrated', confidence: 'confirmed', recordEstimate: 14_500n, notificationRequired: true, notes: 'Seen in egress logs.' }),
  row({ scopeId: 2n, incidentId: id, assetId: 'file-storage', dataSet: 'HR shares', category: 'pii', classification: 'confidential', status: 'encrypted' }),
  row({ scopeId: 3n, incidentId: id, dataSet: 'Audit logs', category: 'logs', classification: 'internal', status: 'not_affected', confidence: 'confirmed' }),
];

function renderPanel(d: SentinelData, incidentId: bigint) {
  const inc = d.incidents.find(i => i.incidentId === incidentId)!;
  return render(
    <ToastProvider>
      <SentinelDataContext.Provider value={d}>
        <MemoryRouter>
          <ScopePanel incident={inc} />
        </MemoryRouter>
      </SentinelDataContext.Provider>
    </ToastProvider>
  );
}

describe('data scope vocabulary', () => {
  it('matches the values the server validates', () => {
    expect(Object.keys(SCOPE_STATUS).sort()).toEqual([...server.SCOPE_STATUSES].sort());
    expect(Object.keys(SCOPE_CATEGORY).sort()).toEqual([...server.SCOPE_CATEGORIES].sort());
    expect(Object.keys(SCOPE_CLASSIFICATION).sort()).toEqual([...server.SCOPE_CLASSIFICATIONS].sort());
  });

  it('summarizes compromised data, known records and notification flags', () => {
    const s = summarizeScope(sample(1n));
    expect(s).toMatchObject({ total: 3, compromised: 2, records: 14_500n, unknownCounts: 1, notify: 1, confirmed: 2 });
  });
});

describe('ScopePanel', () => {
  it('shows the summary and each data set with its state, worst first', () => {
    const { d, db } = withScope(sample);
    renderPanel(d, db.incidentId);
    const sum = within(screen.getByRole('group', { name: 'Data scope summary' }));
    expect(sum.getByText('Data sets compromised').nextSibling).toHaveTextContent('2 of 3');
    expect(sum.getByText('Records at risk').nextSibling).toHaveTextContent('14,500');
    expect(sum.getByText('Notification likely').nextSibling).toHaveTextContent('1');
    const items = screen.getAllByRole('listitem', { name: /^Scope:/ });
    expect(items.map(i => i.getAttribute('aria-label'))).toEqual(['Scope: Payment card tokens', 'Scope: HR shares', 'Scope: Audit logs']);
    expect(within(items[1]!).getByText('Locked by ransomware')).toBeInTheDocument();
    expect(within(items[1]!).getByText(/Availability impact/)).toBeInTheDocument();
    expect(within(items[0]!).getByText('Confirmed')).toBeInTheDocument();
    expect(within(items[0]!).getByText(/Notification likely/)).toBeInTheDocument();
  });

  it('lets a commander add and update scope, with a one-tap status picker', () => {
    const { d, db } = withScope(sample);
    renderPanel(d, db.incidentId);
    fireEvent.click(screen.getByRole('button', { name: /Add data/ }));
    const dialog = screen.getByRole('dialog', { name: 'Add data to scope' });
    expect(within(dialog).getAllByRole('radio')).toHaveLength(9 + 2);
    expect(within(dialog).getByRole('button', { name: 'Add to scope' })).toBeDisabled();
    fireEvent.change(within(dialog).getByPlaceholderText('Customer account records'), { target: { value: 'Billing exports' } });
    fireEvent.click(within(dialog).getByRole('radio', { name: /Exfiltrated/ }));
    expect(within(dialog).getByRole('radio', { name: /Exfiltrated/ })).toHaveAttribute('aria-checked', 'true');
    expect(within(dialog).getByRole('button', { name: 'Add to scope' })).toBeEnabled();
    fireEvent.change(within(dialog).getByPlaceholderText('Unknown'), { target: { value: 'lots' } });
    expect(within(dialog).getByRole('button', { name: 'Add to scope' })).toBeDisabled();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    fireEvent.click(screen.getByRole('button', { name: 'Update HR shares' }));
    expect(screen.getByRole('button', { name: 'Save changes' })).toBeInTheDocument();
  });

  it('observers can read scope but not change it', () => {
    const { d, db } = withScope(sample);
    const observer = { ...d, me: d.me ? { ...d.me, role: 'observer' } : undefined } as SentinelData;
    renderPanel(observer, db.incidentId);
    expect(screen.queryByRole('button', { name: /Add data/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Update / })).toBeNull();
    expect(screen.getByText(/Commanders, analysts and legal can edit/)).toBeInTheDocument();
  });

  it('asks for scope when none is documented', () => {
    const { d, db } = withScope(() => []);
    renderPanel(d, db.incidentId);
    expect(screen.getByText('No data recorded in scope yet.')).toBeInTheDocument();
  });
});

describe('incident report', () => {
  it('includes the data scope table and notes', () => {
    const { d, db } = withScope(sample);
    const md = buildIncidentReport(d, db.incidentId, new Date('2026-11-08T12:00:00Z'))!;
    expect(md).toMatch(/## Data scope \(compromised data\)/);
    expect(md).toMatch(/2 of 3 data sets currently compromised; about 14,500 records at risk \(\+1 data sets with unknown count\); 2 confirmed; notification likely for 1\./);
    expect(md).toMatch(/\| Payment card tokens \| Primary Database \| Financial \| Restricted \| \*\*Exfiltrated\*\* \| Confidentiality \| confirmed \| 14,500 \| yes \|/);
    expect(md).toMatch(/- \*\*Payment card tokens\*\*: Seen in egress logs\./);
  });

  it('says so when no scope is documented', () => {
    const { d, db } = withScope(() => []);
    expect(buildIncidentReport(d, db.incidentId)!).toMatch(/_No data scope documented._/);
  });
});
