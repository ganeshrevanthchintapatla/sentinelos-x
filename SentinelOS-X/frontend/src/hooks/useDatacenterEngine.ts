// Mounts the shared three.js datacenter engine into two host elements and keeps it in
// sync with a SceneModel. The engine itself (lib/datacenter3d.ts) is the same one the
// Situation hero uses; this hook only owns its lifecycle.
import { useEffect, useRef, useState } from 'react';
import { createDatacenter, supportsWebGL, type Datacenter, type SceneModel } from '../lib/datacenter3d';

export function prefersReducedMotion() {
  return typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
}

export function useDatacenterEngine(model: SceneModel, onPick: (id: string) => void) {
  const canvasHost = useRef<HTMLDivElement>(null);
  const labelHost = useRef<HTMLDivElement>(null);
  const engine = useRef<Datacenter | null>(null);
  const [webgl] = useState(supportsWebGL);
  const [ready, setReady] = useState(false);
  const modelRef = useRef(model);
  modelRef.current = model;
  const pickRef = useRef(onPick);
  pickRef.current = onPick;

  useEffect(() => {
    if (!webgl || !canvasHost.current || !labelHost.current) return;
    let disposed = false;
    let dc: Datacenter | null = null;
    void createDatacenter(canvasHost.current, labelHost.current, { reducedMotion: prefersReducedMotion(), onPick: id => pickRef.current(id) })
      .then(d => {
        if (disposed) return d.dispose();
        dc = d;
        engine.current = d;
        d.setModel(modelRef.current);
        setReady(true);
      })
      .catch(() => setReady(false));
    return () => {
      disposed = true;
      dc?.dispose();
      engine.current = null;
    };
  }, [webgl]);

  useEffect(() => {
    engine.current?.setModel(model);
  }, [model, ready]);

  return { canvasHost, labelHost, webgl, ready, replay: () => engine.current?.playDetection() };
}
