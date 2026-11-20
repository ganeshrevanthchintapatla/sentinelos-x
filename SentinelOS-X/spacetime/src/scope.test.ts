// Data-compromise scope reducers on the real WASM datastore: validation, roles,
// history (timeline + audit) and the engine's suggested starting scope.
import { describe, expect, it } from 'vitest';
import { ConnectionId, Timestamp } from 'spacetimedb';
import { createModuleTestHarness, TestAuth } from 'spacetimedb/server/test-utils';
import spacetime, * as m from './index';

const auth = (sub: string, c: bigint) => TestAuth.fromJwtPayload(JSON.stringify({ iss: 'sentinelos-test', sub }), new ConnectionId(c));

function setup(scenarioType = 'database_outage') {
  const h = createModuleTestHarness(spacetime, m);
  let t = 1_700_000_000_000_000n;
  const step = () => h.clock.set(new Timestamp((t += 1_000_000n)));
  step();
  const ic = auth('ic', 1n);
  const analyst = auth('analyst', 2n);
  const legal = auth('legal', 3n);
  const observer = auth('observer', 4n);
  const stranger = auth('stranger', 5n);
  h.withReducerTx(ic, ctx => m.init(ctx, {}));
  h.withReducerTx(ic, ctx => m.register_responder(ctx, { displayName: 'IC' }));
  h.withReducerTx(analyst, ctx => {
    m.register_responder(ctx, { displayName: 'Analyst' });
    m.dev_claim_role(ctx, { role: 'security_analyst' });
  });
  h.withReducerTx(legal, ctx => {
    m.register_responder(ctx, { displayName: 'Legal' });
    m.dev_claim_role(ctx, { role: 'legal_responder' });
  });
  h.withReducerTx(observer, ctx => m.register_responder(ctx, { displayName: 'Observer' }));
  step();
  h.withReducerTx(analyst, ctx => m.launch_simulated_incident(ctx, { scenarioType, title: '' }));
  const incidentId = [...h.db.incident.iter()][0]!.incidentId;
  return { h, step, ic, analyst, legal, observer, stranger, incidentId };
}

const entry = (incidentId: bigint, over: Partial<Parameters<typeof m.record_data_scope>[1]> = {}) => ({
  incidentId,
  assetId: 'primary-db',
  dataSet: 'Payment card tokens',
  category: 'financial',
  classification: 'restricted',
  recordEstimate: 12_000n,
  status: 'exfiltrated',
  confidence: 'suspected',
  notificationRequired: true,
  notes: 'Outbound transfer to unknown host seen in proxy logs.',
  ...over,
});

describe('data-compromise scope', () => {
  it('the engine suggests a suspected starting scope for scenarios that touch data', () => {
    const { h, incidentId } = setup('file_ransomware');
    const rows = [...h.db.dataScope.iter()];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ incidentId, assetId: 'file-storage', status: 'encrypted', confidence: 'suspected', source: 'engine', createdBy: undefined });
    expect([...h.db.incidentEvent.iter()].some(e => e.eventType === 'data_scope_recorded' && e.incidentId === incidentId)).toBe(true);
  });

  it('scenarios with no data impact get no suggested scope', () => {
    const { h } = setup('traffic_surge');
    expect([...h.db.dataScope.iter()]).toHaveLength(0);
  });

  it('a responder records scope; it is timestamped, attributed, on the timeline and audited', () => {
    const { h, analyst, incidentId } = setup();
    h.withReducerTx(analyst, ctx => m.record_data_scope(ctx, entry(incidentId)));
    const row = [...h.db.dataScope.iter()].find(s => s.source === 'responder')!;
    expect(row).toMatchObject({ status: 'exfiltrated', confidence: 'suspected', recordEstimate: 12_000n, notificationRequired: true, createdByName: 'Analyst' });
    const ev = [...h.db.incidentEvent.iter()].filter(e => e.eventType === 'data_scope_recorded' && e.actorName === 'Analyst');
    expect(ev).toHaveLength(1);
    expect(ev[0]!.metadata).toContainEqual({ key: 'scope_id', value: String(row.scopeId) });
    expect([...h.db.auditEvent.iter()].some(a => a.action === 'record_data_scope' && a.targetId === String(row.scopeId))).toBe(true);
  });

  it('updates keep history: the row changes and the timeline says what changed', () => {
    const { h, step, analyst, legal, incidentId } = setup();
    h.withReducerTx(analyst, ctx => m.record_data_scope(ctx, entry(incidentId)));
    const id = [...h.db.dataScope.iter()].find(s => s.source === 'responder')!.scopeId;
    step();
    h.withReducerTx(legal, ctx => m.update_data_scope(ctx, { scopeId: id, status: 'exfiltrated', confidence: 'confirmed', recordEstimate: 14_500n, notificationRequired: true, notes: 'Confirmed from egress logs.' }));
    const row = h.db.dataScope.scopeId.find(id)!;
    expect(row).toMatchObject({ confidence: 'confirmed', recordEstimate: 14_500n, updatedByName: 'Legal' });
    const ev = [...h.db.incidentEvent.iter()].find(e => e.eventType === 'data_scope_updated')!;
    expect(ev.description).toMatch(/confidence suspected → confirmed/);
    expect(ev.description).toMatch(/records 12000 → 14500/);
    expect(() => h.withReducerTx(legal, ctx => m.update_data_scope(ctx, { scopeId: id, status: 'exfiltrated', confidence: 'confirmed', recordEstimate: 14_500n, notificationRequired: true, notes: 'Confirmed from egress logs.' }))).toThrow(/Nothing changed/);
  });

  it('observers and unregistered identities cannot change scope', () => {
    const { h, analyst, observer, stranger, incidentId } = setup();
    expect(() => h.withReducerTx(observer, ctx => m.record_data_scope(ctx, entry(incidentId)))).toThrow(/Unauthorized/);
    expect(() => h.withReducerTx(stranger, ctx => m.record_data_scope(ctx, entry(incidentId)))).toThrow(/register|Unauthorized/i);
    h.withReducerTx(analyst, ctx => m.record_data_scope(ctx, entry(incidentId)));
    const id = [...h.db.dataScope.iter()].find(s => s.source === 'responder')!.scopeId;
    expect(() => h.withReducerTx(observer, ctx => m.update_data_scope(ctx, { scopeId: id, status: 'not_affected', confidence: 'confirmed', recordEstimate: 0n, notificationRequired: false, notes: '' }))).toThrow(/Unauthorized/);
    expect(h.db.dataScope.scopeId.find(id)!.status).toBe('exfiltrated');
  });

  it('rejects invalid input and duplicate entries', () => {
    const { h, analyst, incidentId } = setup();
    expect(() => h.withReducerTx(analyst, ctx => m.record_data_scope(ctx, entry(incidentId, { status: 'leaked' })))).toThrow(/Invalid scope status/);
    expect(() => h.withReducerTx(analyst, ctx => m.record_data_scope(ctx, entry(incidentId, { category: 'secret-stuff' })))).toThrow(/Invalid data category/);
    expect(() => h.withReducerTx(analyst, ctx => m.record_data_scope(ctx, entry(incidentId, { assetId: 'no-such-asset' })))).toThrow(/not found/);
    expect(() => h.withReducerTx(analyst, ctx => m.record_data_scope(ctx, entry(incidentId, { dataSet: 'ab' })))).toThrow(/at least 3/);
    expect(() => h.withReducerTx(analyst, ctx => m.record_data_scope(ctx, entry(incidentId, { recordEstimate: 2_000_000_000_000n })))).toThrow(/Record estimate/);
    expect(() => h.withReducerTx(analyst, ctx => m.record_data_scope(ctx, entry(999n)))).toThrow(/not found/);
    h.withReducerTx(analyst, ctx => m.record_data_scope(ctx, entry(incidentId)));
    expect(() => h.withReducerTx(analyst, ctx => m.record_data_scope(ctx, entry(incidentId, { dataSet: 'payment card TOKENS' })))).toThrow(/already in scope/);
  });

  it('scope can still be documented after the incident is resolved', () => {
    const { h, ic, analyst, incidentId } = setup('traffic_surge');
    h.withReducerTx(analyst, ctx => m.apply_containment(ctx, { incidentId, assetId: 'ext-gateway' }));
    h.withReducerTx(analyst, ctx => m.request_recovery(ctx, { incidentId, assetId: 'ext-gateway', plan: 'Scale out gateway capacity' }));
    const rid = [...h.db.recoveryAction.iter()][0]!.recoveryId;
    h.withReducerTx(ic, ctx => m.decide_recovery(ctx, { recoveryId: rid, approve: true, note: '' }));
    // Drive the engine until the asset is healthy, then resolve.
    for (let i = 0; i < 10; i++) h.withReducerTx(TestAuth.internal(), ctx => m.simulation_tick(ctx, { timer: { scheduledId: 1n, scheduledAt: { tag: 'Interval', value: { __time_duration_micros__: 3_000_000n } } as never } }));
    h.withReducerTx(ic, ctx => m.resolve_incident(ctx, { incidentId, summary: 'Gateway scaled out, traffic normal.' }));
    expect(h.db.incident.incidentId.find(incidentId)!.status).toBe('resolved');
    h.withReducerTx(analyst, ctx => m.record_data_scope(ctx, entry(incidentId, { assetId: 'ext-gateway', dataSet: 'Gateway access logs', category: 'logs', status: 'not_affected', confidence: 'confirmed', recordEstimate: 0n, notificationRequired: false })));
    expect([...h.db.dataScope.iter()]).toHaveLength(1);
  });
});
