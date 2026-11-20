// The 3D datacenter is driven only by subscribed rows. These tests check the
// pure mapping (racks, rows, focus, routed blast edges) on reducer-produced data.
import { describe, expect, it } from 'vitest';
import { loadScenario } from './fixtures/load';
import { buildSceneModel, focusIncident, rackState } from '../lib/datacenterModel';

describe('3D datacenter scene model', () => {
  const d = loadScenario();

  it('places every service exactly once, one row per environment', () => {
    const m = buildSceneModel(d.assets, d.incidents, d.incidentAssets);
    expect(m.racks).toHaveLength(d.assets.length);
    expect(new Set(m.racks.map(r => `${r.row}:${r.slot}`)).size).toBe(m.racks.length);
    expect(m.rows).toEqual([...new Set(d.assets.map(a => a.environment))].sort());
    for (const r of m.racks) expect(r.slot).toBeLessThan(m.slots);
  });

  it('mirrors server health, including exposure', () => {
    const m = buildSceneModel(d.assets, d.incidents, d.incidentAssets);
    for (const a of d.assets) expect(m.racks.find(r => r.id === a.assetId)!.state).toBe(rackState(a));
    expect(m.racks.find(r => r.id === 'primary-db')!.state).toBe('critical');
  });

  it('frames the most urgent open incident and routes its cause chain', () => {
    const m = buildSceneModel(d.assets, d.incidents, d.incidentAssets);
    const inc = focusIncident(d.incidents)!;
    expect(m.focusIncident?.incidentId).toBe(inc.incidentId);
    expect(m.racks.filter(r => r.root)).toHaveLength(1);
    expect(m.racks.find(r => r.root)!.id).toBe(m.focus);
    for (const e of m.edges) {
      const link = d.incidentAssets.find(ia => ia.incidentId === inc.incidentId && ia.assetId === e.to);
      expect(link?.causedByAssetId).toBe(e.from);
    }
  });

  it('spotlights a newly detected incident instead of the most urgent one', () => {
    const db = d.incidents.find(i => i.scenarioType === 'database_outage')!;
    const m = buildSceneModel(d.assets, d.incidents, d.incidentAssets, String(db.incidentId));
    expect(m.focusIncident?.incidentId).toBe(db.incidentId);
    expect(m.focus).toBe('primary-db');
    expect(m.edges.length).toBeGreaterThan(0);
  });

  it('shows an all-clear floor when nothing is open', () => {
    const m = buildSceneModel(d.assets, [], d.incidentAssets);
    expect(m.focusIncident).toBeUndefined();
    expect(m.edges).toHaveLength(0);
  });
});

// Component behaviour without WebGL (jsdom): the caption and focus still follow live rows.
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { vi } from 'vitest';
import { Identity } from 'spacetimedb';
import { scenarioIdentityHex } from './fixtures/load';
import { SentinelDataContext, type SentinelData } from '../hooks/useSentinelData';
import { DatacenterHero } from '../features/dashboard/DatacenterHero';

vi.mock('spacetimedb/react', () => ({
  useSpacetimeDB: () => ({ isActive: true, identity: Identity.fromString(scenarioIdentityHex), connectionError: undefined, getConnection: () => null }),
  useTable: () => [[], true],
}));

describe('DatacenterHero', () => {
  const hero = (data: SentinelData) => (
    <SentinelDataContext.Provider value={data}>
      <MemoryRouter>
        <DatacenterHero />
      </MemoryRouter>
    </SentinelDataContext.Provider>
  );
  const label = () => screen.getByRole('img', { name: /3D datacenter/ }).getAttribute('aria-label') ?? '';

  it('spotlights a newly opened incident even when an older one is more severe', () => {
    const d = loadScenario();
    const db = d.incidents.find(i => i.scenarioType === 'database_outage')!;
    const before = { ...d, incidents: d.incidents.filter(i => i.incidentId !== db.incidentId) } as SentinelData;
    const { rerender } = render(hero(before));
    expect(label()).not.toMatch(new RegExp(`INC-${db.incidentId} `));
    rerender(hero(d));
    expect(label()).toMatch(new RegExp(`Focus: INC-${db.incidentId} at Primary Database`));
  });

  it('says so plainly when WebGL is unavailable', () => {
    render(hero(loadScenario()));
    expect(screen.getByText(/needs WebGL/)).toBeInTheDocument();
  });
});
