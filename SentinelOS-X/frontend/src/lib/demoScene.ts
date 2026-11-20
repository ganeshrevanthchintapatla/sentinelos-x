// Pure mapping from a demo snapshot to the existing 3D SceneModel. No three.js here.
import type { RackModel, RackState, SceneModel } from './datacenter3d';
import type { DemoIncident, DemoServer, DemoSnapshot } from './demoTypes';

export function serverRackState(s: DemoServer): RackState {
  return s.status === 'affected' ? 'critical' : s.status === 'remediating' ? 'recovering' : 'healthy';
}

export const isActiveIncident = (i: DemoIncident) => i.status !== 'resolved';

/** The most recently opened active incident (the view frames its server). */
export function focusDemoIncident(incidents: readonly DemoIncident[]): DemoIncident | undefined {
  return [...incidents].filter(isActiveIncident).sort((a, b) => b.opened_at - a.opened_at)[0];
}

export function buildDemoScene(snap: DemoSnapshot): SceneModel & { focusIncident?: DemoIncident; affected: number } {
  const racksSet = new Set<string>(['A', 'B', 'C', 'D']);
  for (const s of snap.servers) racksSet.add(s.rack);
  const rows = [...racksSet].sort();
  const byRack = new Map<string, DemoServer[]>();
  for (const s of snap.servers) byRack.set(s.rack, [...(byRack.get(s.rack) ?? []), s]);
  const slots = Math.max(0, ...[...byRack.values()].map(l => l.length)) + 2;

  const inc = focusDemoIncident(snap.incidents);
  const focus = inc && snap.servers.some(s => s.id === inc.server_id) ? inc.server_id : undefined;

  const racks: RackModel[] = [];
  rows.forEach((rack, row) => {
    const list = [...(byRack.get(rack) ?? [])].sort((a, b) => a.id.localeCompare(b.id));
    const start = Math.floor((slots - list.length) / 2);
    list.forEach((s, i) => racks.push({ id: s.id, name: s.name, row, slot: start + i, state: serverRackState(s), root: s.status === 'affected' }));
  });
  return { rows, slots, racks, edges: [], focus, focusIncident: inc, affected: snap.servers.filter(s => s.status !== 'healthy').length };
}
