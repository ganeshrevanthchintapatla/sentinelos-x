// Pure mapping from subscribed rows to the 3D datacenter scene. No three.js here,
// so it is cheap to import and easy to test.
import type { Asset, Incident, IncidentAsset } from '../types/domain';
import { SEVERITY_RANK } from '../types/domain';
import type { EdgeModel, RackModel, RackState, SceneModel } from './datacenter3d';

export function rackState(a: Asset): RackState {
  if (a.healthStatus === 'healthy' && a.impactType === 'exposed') return 'exposed';
  if (a.healthStatus === 'degraded' || a.healthStatus === 'critical' || a.healthStatus === 'offline' || a.healthStatus === 'recovering') return a.healthStatus;
  return 'healthy';
}

/** The open incident the view should frame: highest severity, then newest. */
export function focusIncident(incidents: readonly Incident[]): Incident | undefined {
  return [...incidents]
    .filter(i => i.status !== 'resolved')
    .sort((a, b) => (SEVERITY_RANK[b.severity] ?? 0) - (SEVERITY_RANK[a.severity] ?? 0) || (a.createdAt.microsSinceUnixEpoch < b.createdAt.microsSinceUnixEpoch ? 1 : -1))[0];
}

/**
 * @param spotlight an incident to frame instead of the most urgent one (used
 * while a newly detected incident plays its detection sequence). Ignored once
 * that incident is resolved.
 */
export function buildSceneModel(
  assets: readonly Asset[],
  incidents: readonly Incident[],
  incidentAssets: readonly IncidentAsset[],
  spotlight?: string | null
): SceneModel & { focusIncident?: Incident; affected: number } {
  const byEnv = new Map<string, Asset[]>();
  for (const a of assets) byEnv.set(a.environment, [...(byEnv.get(a.environment) ?? []), a]);
  const rows = [...byEnv.keys()].sort();
  const longest = Math.max(0, ...[...byEnv.values()].map(l => l.length));
  const slots = longest + 2;

  const inc = incidents.find(i => spotlight && String(i.incidentId) === spotlight && i.status !== 'resolved') ?? focusIncident(incidents);
  const links = inc ? incidentAssets.filter(ia => ia.incidentId === inc.incidentId && ia.impactStatus !== 'recovered') : [];
  const rootId = inc ? (links.find(l => l.depth === 0)?.assetId ?? inc.initialAssetId) : undefined;

  const racks: RackModel[] = [];
  rows.forEach((env, row) => {
    const list = [...(byEnv.get(env) ?? [])].sort((a, b) => a.assetId.localeCompare(b.assetId));
    const start = Math.floor((slots - list.length) / 2);
    list.forEach((a, i) => racks.push({ id: a.assetId, name: a.name, row, slot: start + i, state: rackState(a), root: a.assetId === rootId }));
  });

  const stateOf = new Map(racks.map(r => [r.id, r.state]));
  const edges: EdgeModel[] = links
    .filter(l => l.causedByAssetId && stateOf.has(l.causedByAssetId) && stateOf.has(l.assetId))
    .sort((a, b) => a.depth - b.depth || a.assetId.localeCompare(b.assetId))
    .map(l => ({ from: l.causedByAssetId!, to: l.assetId, state: stateOf.get(l.assetId)! }));

  return { rows, slots, racks, edges, focus: rootId, focusIncident: inc, affected: links.length };
}
