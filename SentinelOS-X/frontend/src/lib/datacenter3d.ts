// 3D datacenter view of the digital twin.
//
// Every rack is one service from the SpacetimeDB `asset` table, grouped into
// rows by environment. Nothing here is decorative state: rack colour, markers
// and the routed paths are drawn from server rows (asset health, incident_asset
// cause chains). Empty rack frames only pad rows to an even length and carry
// no data.
//
// three.js is bundled with the app and loaded on demand, so the view works on
// an isolated network and costs nothing for pages that do not show it.
import type * as ThreeNS from 'three';

type THREE = typeof ThreeNS;

export type RackState = 'healthy' | 'degraded' | 'critical' | 'offline' | 'recovering' | 'exposed';

export interface RackModel {
  id: string;
  name: string;
  row: number;
  slot: number;
  state: RackState;
  /** True for the root cause of the focused incident. */
  root?: boolean;
}

export interface EdgeModel {
  from: string;
  to: string;
  state: RackState;
}

export interface SceneModel {
  rows: string[];
  slots: number;
  racks: RackModel[];
  edges: EdgeModel[];
  /** Asset the camera should frame (root cause of the most urgent incident). */
  focus?: string;
}

export interface Datacenter {
  setModel(m: SceneModel): void;
  /** Replays the detection sequence: top-down sweep, then tilt onto the focus and trace the blast radius. */
  playDetection(): void;
  dispose(): void;
}

export const STATE_HEX: Record<RackState, string> = {
  healthy: '#3d8a63',
  degraded: '#fbbf24',
  critical: '#f0524f',
  offline: '#fb923c',
  recovering: '#60a5fa',
  exposed: '#a78bfa',
};

export const STATE_WORD: Record<RackState, string> = {
  healthy: 'healthy',
  degraded: 'degraded',
  critical: 'critical',
  offline: 'offline',
  recovering: 'recovering',
  exposed: 'at risk',
};

const RACK_W = 1.0;
const RACK_H = 2.4;
const RACK_D = 1.2;
const SLOT_GAP = 1.22;
const ROW_GAP = 3.6;
const UNITS = 9;
const BG = '#111317';

export function supportsWebGL(): boolean {
  try {
    if (typeof window === 'undefined' || typeof document === 'undefined') return false;
    if (!('WebGLRenderingContext' in window)) return false;
    const c = document.createElement('canvas');
    return !!(c.getContext('webgl2') || c.getContext('webgl'));
  } catch {
    return false;
  }
}

const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const clamp01 = (t: number) => Math.min(1, Math.max(0, t));

interface RackObj {
  model: RackModel;
  group: ThreeNS.Group;
  body: ThreeNS.Mesh<ThreeNS.BoxGeometry, ThreeNS.MeshStandardMaterial>;
  leds: ThreeNS.Mesh<ThreeNS.BoxGeometry, ThreeNS.MeshBasicMaterial>[];
  marker: ThreeNS.Mesh<ThreeNS.CylinderGeometry, ThreeNS.MeshStandardMaterial>;
  beam: ThreeNS.Mesh<ThreeNS.CylinderGeometry, ThreeNS.MeshBasicMaterial>;
  tile: ThreeNS.Mesh<ThreeNS.PlaneGeometry, ThreeNS.MeshBasicMaterial>;
  label: HTMLDivElement;
  /** 0 → 1 pop-in of the marker during the detection sequence. */
  reveal: number;
}

interface EdgeObj {
  mesh: ThreeNS.Mesh<ThreeNS.TubeGeometry, ThreeNS.MeshBasicMaterial>;
  total: number;
  delay: number;
}

export async function createDatacenter(
  host: HTMLElement,
  labelHost: HTMLElement,
  opts: { reducedMotion: boolean; onPick: (assetId: string) => void }
): Promise<Datacenter> {
  const T: THREE = await import('three');

  const renderer = new T.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = T.PCFShadowMap;
  renderer.outputColorSpace = T.SRGBColorSpace;
  renderer.toneMapping = T.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.2;
  renderer.domElement.setAttribute('aria-hidden', 'true');
  renderer.domElement.style.display = 'block';
  host.appendChild(renderer.domElement);

  const scene = new T.Scene();
  scene.background = new T.Color(BG);
  scene.fog = new T.Fog(BG, 34, 78);

  const camera = new T.PerspectiveCamera(30, 1, 0.1, 200);

  scene.add(new T.HemisphereLight('#d8dde5', '#0a0b0d', 0.7));
  const key = new T.DirectionalLight('#ffffff', 2.1);
  key.position.set(12, 22, 14);
  key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048);
  key.shadow.camera.left = -26;
  key.shadow.camera.right = 26;
  key.shadow.camera.top = 26;
  key.shadow.camera.bottom = -26;
  key.shadow.camera.far = 80;
  key.shadow.bias = -0.0005;
  key.shadow.radius = 4;
  scene.add(key);
  const rim = new T.DirectionalLight('#8fa6c8', 0.45);
  rim.position.set(-14, 10, -12);
  scene.add(rim);

  const floor = new T.Mesh(new T.PlaneGeometry(160, 160), new T.MeshStandardMaterial({ color: '#16191d', roughness: 0.96, metalness: 0 }));
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;
  scene.add(floor);
  const grid = new T.GridHelper(160, 128, '#24282f', '#1c1f24');
  grid.position.y = 0.003;
  (grid.material as ThreeNS.Material).transparent = true;
  (grid.material as ThreeNS.Material).opacity = 0.55;
  scene.add(grid);

  // Shared geometries.
  const gBody = new T.BoxGeometry(RACK_W, RACK_H, RACK_D);
  const gUnit = new T.BoxGeometry(RACK_W * 0.86, 0.17, 0.03);
  const gLed = new T.BoxGeometry(0.07, 0.045, 0.02);
  const gHex = new T.CylinderGeometry(0.44, 0.44, 0.13, 6);
  const gBeam = new T.CylinderGeometry(0.012, 0.012, 1, 6);
  const gTile = new T.PlaneGeometry(RACK_W * 1.7, RACK_D * 2.1);
  const gFrame = new T.EdgesGeometry(gBody);
  const unitMat = new T.MeshStandardMaterial({ color: '#1a1d22', roughness: 0.55, metalness: 0.35 });
  const frameMat = new T.LineBasicMaterial({ color: '#2f343c' });

  const world = new T.Group();
  scene.add(world);
  const racks = new Map<string, RackObj>();
  const fillers: ThreeNS.Object3D[] = [];
  let edges: EdgeObj[] = [];
  let model: SceneModel = { rows: [], slots: 0, racks: [], edges: [] };
  let layoutKey = '';
  let edgeKey = '';

  const posOf = (row: number, slot: number) =>
    new T.Vector3((slot - (model.slots - 1) / 2) * SLOT_GAP, 0, (row - (model.rows.length - 1) / 2) * ROW_GAP);
  const sideX = () => -((model.slots - 1) / 2) * SLOT_GAP - 1.15;
  const aisleZ = (row: number) => posOf(row, 0).z + RACK_D / 2 + 0.75;

  function clearRacks() {
    for (const r of racks.values()) {
      world.remove(r.group);
      r.body.material.dispose();
      r.marker.material.dispose();
      r.beam.material.dispose();
      r.tile.material.dispose();
      r.leds.forEach(l => l.material.dispose());
      r.label.remove();
    }
    racks.clear();
    fillers.forEach(f => world.remove(f));
    fillers.length = 0;
  }

  function buildRacks() {
    clearRacks();
    const used = new Set<string>();
    for (const m of model.racks) {
      const group = new T.Group();
      group.position.copy(posOf(m.row, m.slot));
      const body = new T.Mesh(gBody, new T.MeshStandardMaterial({ color: '#343a44', roughness: 0.62, metalness: 0.25, emissive: new T.Color('#000000') }));
      body.position.y = RACK_H / 2;
      body.castShadow = true;
      body.receiveShadow = true;
      body.userData.assetId = m.id;
      group.add(body);
      const leds: RackObj['leds'] = [];
      for (let u = 0; u < UNITS; u++) {
        const y = 0.32 + u * 0.22;
        const unit = new T.Mesh(gUnit, unitMat);
        unit.position.set(0, y, RACK_D / 2 + 0.016);
        group.add(unit);
        const led = new T.Mesh(gLed, new T.MeshBasicMaterial({ color: STATE_HEX.healthy }));
        led.position.set(RACK_W * 0.34, y, RACK_D / 2 + 0.035);
        group.add(led);
        leds.push(led);
      }
      const marker = new T.Mesh(gHex, new T.MeshStandardMaterial({ color: '#ffffff', emissive: new T.Color('#ffffff'), emissiveIntensity: 0.9, roughness: 0.35, metalness: 0.1 }));
      marker.position.y = RACK_H + 0.95;
      marker.castShadow = true;
      group.add(marker);
      const beam = new T.Mesh(gBeam, new T.MeshBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0.45 }));
      beam.scale.y = 0.75;
      beam.position.y = RACK_H + 0.42;
      group.add(beam);
      const tile = new T.Mesh(gTile, new T.MeshBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0.16, depthWrite: false }));
      tile.rotation.x = -Math.PI / 2;
      tile.position.y = 0.006;
      group.add(tile);
      world.add(group);

      const label = document.createElement('div');
      label.className = 'dc-label';
      label.addEventListener('click', () => opts.onPick(m.id));
      labelHost.appendChild(label);

      const obj: RackObj = { model: m, group, body, leds, marker, beam, tile, label, reveal: 1 };
      racks.set(m.id, obj);
      used.add(`${m.row}:${m.slot}`);
      applyState(obj);
    }
    // Empty rack positions, drawn as open frames.
    for (let r = 0; r < model.rows.length; r++)
      for (let s = 0; s < model.slots; s++) {
        if (used.has(`${r}:${s}`)) continue;
        const f = new T.LineSegments(gFrame, frameMat);
        f.position.copy(posOf(r, s));
        f.position.y = RACK_H / 2;
        world.add(f);
        fillers.push(f);
      }
  }

  function applyState(o: RackObj) {
    const st = o.model.state;
    const hex = new T.Color(STATE_HEX[st]);
    const flagged = st !== 'healthy';
    o.body.material.color.set(st === 'offline' ? '#22262c' : '#343a44');
    o.body.material.emissive.copy(flagged ? hex : new T.Color('#000000'));
    o.body.material.emissiveIntensity = flagged ? 0.12 : 0;
    o.leds.forEach((l, i) => l.material.color.set(st === 'offline' ? (i % 3 === 0 ? STATE_HEX.offline : '#202328') : st === 'healthy' ? STATE_HEX.healthy : STATE_HEX[st]));
    o.marker.visible = flagged;
    o.beam.visible = flagged;
    o.tile.visible = flagged;
    o.marker.material.color.copy(hex);
    o.marker.material.emissive.copy(hex);
    o.beam.material.color.copy(hex);
    o.tile.material.color.copy(hex);
    o.marker.scale.setScalar(o.model.root ? 1.35 : 1);
    o.label.innerHTML = '';
    const dot = document.createElement('span');
    dot.className = 'dc-dot';
    dot.style.background = STATE_HEX[st];
    const name = document.createElement('span');
    name.textContent = o.model.name;
    const word = document.createElement('span');
    word.className = 'dc-word';
    word.textContent = o.model.root ? 'root cause' : STATE_WORD[st];
    o.label.append(dot, name, word);
    o.label.dataset.flagged = String(flagged);
    o.label.dataset.root = String(!!o.model.root);
  }

  function clearEdges() {
    edges.forEach(e => {
      world.remove(e.mesh);
      e.mesh.geometry.dispose();
      e.mesh.material.dispose();
    });
    edges = [];
  }

  function buildEdges() {
    clearEdges();
    model.edges.forEach((e, i) => {
      const a = racks.get(e.from)?.model;
      const b = racks.get(e.to)?.model;
      if (!a || !b) return;
      const y = 0.05;
      const off = ((i % 5) - 2) * 0.07;
      const pa = posOf(a.row, a.slot);
      const pb = posOf(b.row, b.slot);
      const pts: ThreeNS.Vector3[] = [new T.Vector3(pa.x, y, pa.z + RACK_D / 2 + 0.2)];
      const za = aisleZ(a.row) + off;
      const zb = aisleZ(b.row) + off;
      pts.push(new T.Vector3(pa.x, y, za));
      if (a.row !== b.row) {
        const sx = sideX() - Math.abs(off);
        pts.push(new T.Vector3(sx, y, za), new T.Vector3(sx, y, zb));
      }
      pts.push(new T.Vector3(pb.x, y, zb), new T.Vector3(pb.x, y, pb.z + RACK_D / 2 + 0.2));
      const path = new T.CurvePath<ThreeNS.Vector3>();
      for (let k = 0; k < pts.length - 1; k++) if (!pts[k]!.equals(pts[k + 1]!)) path.add(new T.LineCurve3(pts[k]!, pts[k + 1]!));
      if (path.curves.length === 0) return;
      const geo = new T.TubeGeometry(path, Math.max(24, Math.round(path.getLength() * 10)), 0.032, 6, false);
      const mat = new T.MeshBasicMaterial({ color: STATE_HEX[e.state], transparent: true, opacity: 0.95 });
      const mesh = new T.Mesh(geo, mat);
      world.add(mesh);
      const total = geo.index ? geo.index.count : 0;
      edges.push({ mesh, total, delay: i * 0.18 });
    });
  }

  // Camera choreography ------------------------------------------------------
  const center = new T.Vector3();
  const cam = { pos: new T.Vector3(0, 30, 0.01), target: new T.Vector3() };
  let tween: { from: { pos: ThreeNS.Vector3; target: ThreeNS.Vector3 }; t0: number; dur: number } | null = null;
  let detectionAt = -1;
  let orbit = 0.6;

  const overviewPose = () => {
    const span = Math.max(model.slots * SLOT_GAP, model.rows.length * ROW_GAP);
    return { pos: new T.Vector3(center.x + span * 0.62, span * 0.62, center.z + span * 0.78), target: new T.Vector3(center.x, 1.4, center.z) };
  };
  const topDownPose = () => {
    const span = Math.max(model.slots * SLOT_GAP, model.rows.length * ROW_GAP);
    return { pos: new T.Vector3(center.x, span * 2.05, center.z + 0.6), target: center.clone() };
  };
  const focusPose = () => {
    const f = model.focus ? racks.get(model.focus) : undefined;
    if (!f) return overviewPose();
    const t = f.group.position.clone().lerp(center, 0.45);
    t.y = 1.9;
    return { pos: t.clone().add(new T.Vector3(11.5, 12.5, 16)), target: t };
  };

  function goTo(pose: { pos: ThreeNS.Vector3; target: ThreeNS.Vector3 }, dur: number) {
    if (opts.reducedMotion || dur <= 0) {
      cam.pos.copy(pose.pos);
      cam.target.copy(pose.target);
      tween = null;
      return;
    }
    tween = { from: { pos: cam.pos.clone(), target: cam.target.clone() }, t0: performance.now(), dur };
    goal = pose;
  }
  let goal = overviewPose();

  // Interaction ----------------------------------------------------------------
  const ray = new T.Raycaster();
  const ndc = new T.Vector2();
  let hovered: string | null = null;
  const pick = (ev: PointerEvent): string | null => {
    const r = renderer.domElement.getBoundingClientRect();
    ndc.set(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1);
    ray.setFromCamera(ndc, camera);
    const hit = ray.intersectObjects([...racks.values()].map(o => o.body), false)[0];
    return (hit?.object.userData.assetId as string | undefined) ?? null;
  };
  const onMove = (ev: PointerEvent) => {
    hovered = pick(ev);
    renderer.domElement.style.cursor = hovered ? 'pointer' : 'default';
  };
  const onLeave = () => {
    hovered = null;
  };
  const onClick = (ev: PointerEvent) => {
    const id = pick(ev);
    if (id) opts.onPick(id);
  };
  renderer.domElement.addEventListener('pointermove', onMove);
  renderer.domElement.addEventListener('pointerleave', onLeave);
  renderer.domElement.addEventListener('click', onClick);

  // Sizing and visibility --------------------------------------------------------
  const resize = () => {
    const w = host.clientWidth || 1;
    const h = host.clientHeight || 1;
    renderer.setSize(w, h, false);
    renderer.domElement.style.width = '100%';
    renderer.domElement.style.height = '100%';
    // On wide views the caption card sits on the left, so render the right-hand
    // part of a wider frame: the subject lands at ~63% of the width, clear of the card.
    const shift = w >= 760 ? 1.26 : 1;
    camera.aspect = (w * shift) / h;
    if (shift > 1) camera.setViewOffset(w * shift, h, 0, 0, w, h);
    else camera.clearViewOffset();
    camera.updateProjectionMatrix();
  };
  const ro = new ResizeObserver(resize);
  ro.observe(host);
  resize();
  let onScreen = true;
  const io = new IntersectionObserver(entries => {
    onScreen = entries.some(e => e.isIntersecting);
  });
  io.observe(host);

  // Frame loop ---------------------------------------------------------------------
  let raf = 0;
  let last = performance.now();
  const v = new T.Vector3();
  const frame = (now: number) => {
    raf = requestAnimationFrame(frame);
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    if (!onScreen || document.hidden) return;
    const motion = !opts.reducedMotion;

    if (tween) {
      const k = ease(clamp01((now - tween.t0) / tween.dur));
      cam.pos.lerpVectors(tween.from.pos, goal.pos, k);
      cam.target.lerpVectors(tween.from.target, goal.target, k);
      if (k >= 1) tween = null;
    } else if (motion) {
      // Idle drift: a slow orbit around whatever the camera is looking at.
      orbit += dt * (model.focus ? 0.035 : 0.06);
      const base = model.focus ? focusPose() : overviewPose();
      const off = base.pos.clone().sub(base.target);
      const r = Math.hypot(off.x, off.z);
      const a0 = Math.atan2(off.x, off.z);
      const sway = model.focus ? Math.sin(orbit) * 0.22 : orbit;
      const want = base.target.clone().add(new T.Vector3(Math.sin(a0 + sway) * r, off.y, Math.cos(a0 + sway) * r));
      cam.pos.lerp(want, 1 - Math.pow(0.001, dt));
      cam.target.lerp(base.target, 1 - Math.pow(0.001, dt));
    }
    camera.position.copy(cam.pos);
    camera.lookAt(cam.target);

    // Detection sequence progress (seconds since it started).
    const since = detectionAt < 0 ? 99 : (now - detectionAt) / 1000;
    const t = now / 1000;
    let i = 0;
    for (const o of racks.values()) {
      const st = o.model.state;
      if (st !== 'healthy') {
        const reveal = motion ? ease(clamp01((since - 1.4 - (o.model.root ? 0 : 0.6 + (i % 7) * 0.12)) / 0.5)) : 1;
        o.reveal = reveal;
        const bob = motion ? Math.sin(t * 1.6 + i) * 0.08 : 0;
        o.marker.position.y = RACK_H + 0.95 + bob;
        o.marker.rotation.y = motion ? t * 0.5 + i : 0;
        o.marker.scale.setScalar((o.model.root ? 1.35 : 1) * Math.max(0.0001, reveal));
        o.beam.scale.y = 0.75 * Math.max(0.0001, reveal);
        o.tile.material.opacity = 0.16 * reveal;
        const pulse = st === 'critical' && motion ? 0.1 + 0.12 * (0.5 + 0.5 * Math.sin(t * 4)) : 0.12;
        o.body.material.emissiveIntensity = pulse * reveal;
        if (st === 'critical' && motion) o.leds.forEach((l, j) => (l.visible = Math.sin(t * 6 + j) > -0.4));
      }
      // Label placement.
      // Name only what matters: the root cause, anything critical, and the rack under the pointer.
      const show = ((o.model.root || st === 'critical') && o.reveal > 0.6) || hovered === o.model.id;
      if (show) {
        v.copy(o.group.position);
        v.y = st !== 'healthy' ? RACK_H + 1.65 : RACK_H + 0.45;
        v.project(camera);
        const w = host.clientWidth;
        const h = host.clientHeight;
        const x = (v.x * 0.5 + 0.5) * w;
        const y = (-v.y * 0.5 + 0.5) * h;
        const inView = v.z < 1 && x > -40 && x < w + 40 && y > -20 && y < h + 20;
        o.label.style.display = inView ? 'flex' : 'none';
        o.label.style.transform = `translate(-50%, -100%) translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)`;
        o.label.style.zIndex = String(1000 - Math.round(v.z * 500));
      } else {
        o.label.style.display = 'none';
      }
      i++;
    }
    for (const e of edges) {
      const p = motion ? clamp01((since - 2.0 - e.delay) / 1.4) : 1;
      e.mesh.geometry.setDrawRange(0, Math.floor((e.total * ease(p)) / 3) * 3);
      e.mesh.visible = p > 0;
    }
    renderer.render(scene, camera);
  };
  raf = requestAnimationFrame(frame);

  function setModel(m: SceneModel) {
    const prevFocus = model.focus;
    model = m;
    const lk = `${m.rows.join('|')}#${m.slots}#${m.racks.map(r => `${r.id}@${r.row}:${r.slot}`).join(',')}`;
    if (lk !== layoutKey) {
      layoutKey = lk;
      buildRacks();
      center.set(0, 0, 0);
      cam.pos.copy(overviewPose().pos);
      cam.target.copy(center);
    } else {
      for (const r of m.racks) {
        const o = racks.get(r.id);
        if (o && (o.model.state !== r.state || !!o.model.root !== !!r.root || o.model.name !== r.name)) {
          o.model = r;
          applyState(o);
        } else if (o) o.model = r;
      }
    }
    const ek = m.edges.map(e => `${e.from}>${e.to}:${e.state}`).join(',');
    if (ek !== edgeKey) {
      edgeKey = ek;
      buildEdges();
    }
    if (prevFocus !== m.focus && !tween) goTo(m.focus ? focusPose() : overviewPose(), 1600);
  }

  function playDetection() {
    detectionAt = performance.now();
    const top = topDownPose();
    cam.pos.copy(top.pos);
    cam.target.copy(top.target);
    tween = null;
    if (opts.reducedMotion) {
      goTo(model.focus ? focusPose() : overviewPose(), 0);
      return;
    }
    window.setTimeout(() => goTo(model.focus ? focusPose() : overviewPose(), 2600), 500);
  }

  return {
    setModel,
    playDetection,
    dispose() {
      cancelAnimationFrame(raf);
      ro.disconnect();
      io.disconnect();
      renderer.domElement.removeEventListener('pointermove', onMove);
      renderer.domElement.removeEventListener('pointerleave', onLeave);
      renderer.domElement.removeEventListener('click', onClick);
      clearRacks();
      clearEdges();
      [gBody, gUnit, gLed, gHex, gBeam, gTile, gFrame, floor.geometry].forEach(g => g.dispose());
      [unitMat, frameMat, floor.material].forEach(mm => mm.dispose());
      grid.geometry.dispose();
      (grid.material as ThreeNS.Material).dispose();
      renderer.dispose();
      renderer.domElement.remove();
    },
  };
}
