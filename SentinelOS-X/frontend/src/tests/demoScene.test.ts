import { describe, expect, it } from 'vitest';
import { buildDemoScene } from '../lib/demoScene';
import { parseSnapshot, type DemoSnapshot } from '../lib/demoTypes';

const mk = (servers: { id: string; rack: string; status: string }[], incidents: object[] = []): DemoSnapshot =>
  parseSnapshot({ version: 1, now: 100, servers: servers.map(s => ({ name: s.id, role: 'web', ...s })), incidents })!;

const six = [
  { id: 'a1', rack: 'A', status: 'healthy' },
  { id: 'a2', rack: 'A', status: 'healthy' },
  { id: 'a3', rack: 'A', status: 'healthy' },
  { id: 'b1', rack: 'B', status: 'healthy' },
  { id: 'c1', rack: 'C', status: 'healthy' },
  { id: 'd1', rack: 'D', status: 'healthy' },
];

describe('demo scene mapping', () => {
  it('places every server once with rows A-D', () => {
    const m = buildDemoScene(mk(six));
    expect(m.rows).toEqual(['A', 'B', 'C', 'D']);
    expect(m.racks).toHaveLength(6);
    expect(new Set(m.racks.map(r => `${r.row}:${r.slot}`)).size).toBe(6);
    for (const r of m.racks) expect(r.slot).toBeLessThan(m.slots);
    expect(m.focus).toBeUndefined();
    expect(m.racks.every(r => r.state === 'healthy' && !r.root)).toBe(true);
  });

  it('maps statuses and renders several simultaneous incidents', () => {
    const servers = six.map(s => (s.id === 'a2' || s.id === 'd1' ? { ...s, status: 'affected' } : s.id === 'c1' ? { ...s, status: 'remediating' } : s));
    const inc = (id: string, server_id: string, opened_at: number, status = 'investigating') => ({ id, server_id, opened_at, status });
    const m = buildDemoScene(mk(servers, [inc('INC-2', 'd1', 20), inc('INC-1', 'a2', 10), inc('INC-0', 'b1', 30, 'resolved')]));
    const st = (id: string) => m.racks.find(r => r.id === id)!;
    expect(st('a2')).toMatchObject({ state: 'critical', root: true });
    expect(st('d1')).toMatchObject({ state: 'critical', root: true });
    expect(st('c1')).toMatchObject({ state: 'recovering', root: false });
    expect(st('b1').state).toBe('healthy');
    expect(m.focus).toBe('d1');
    expect(m.focusIncident?.id).toBe('INC-2');
    expect(m.affected).toBe(3);
  });

  it('parses defensively', () => {
    expect(parseSnapshot('not json')).toBeNull();
    expect(parseSnapshot(null)).toBeNull();
    const s = parseSnapshot({ servers: [{ id: 'x', status: 'weird' }], incidents: [{ id: 'i', steps: [{ kind: '??' }] }] })!;
    expect(s.servers[0]!.status).toBe('healthy');
    expect(s.incidents[0]!.steps[0]!.kind).toBe('tool_call');
    expect(s.sensor.limits).toEqual({ temp_c: 30, humidity_pct: 70 });
  });
});
