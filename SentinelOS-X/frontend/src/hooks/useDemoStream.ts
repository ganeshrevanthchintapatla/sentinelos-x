// Live feed for the autonomous demo: SSE from the hardware bridge's demo engine, with
// automatic reconnection, a 1.5 s polling fallback, and a clock offset so timers follow
// the server's clock. `?mock=1` swaps the network for a local generator.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createDemoMock, type DemoMock } from '../lib/demoMock';
import { parseSnapshot, type DemoSnapshot } from '../lib/demoTypes';

export const DEMO_URL: string = (import.meta.env.VITE_DEMO_URL as string | undefined) ?? 'http://localhost:8765';
const POLL_MS = 1500;

export type DemoConnection = 'connecting' | 'live' | 'polling' | 'offline' | 'mock';

export function isMockRequested(): boolean {
  try {
    return new URLSearchParams(window.location.search).get('mock') === '1';
  } catch {
    return false;
  }
}

export interface DemoStream {
  snapshot: DemoSnapshot | null;
  connection: DemoConnection;
  /** Server-clock "now" in epoch seconds (client clock corrected by the last snapshot). */
  serverNow: () => number;
  reset: () => Promise<boolean>;
  inject: (kind: 'heat' | 'humidity' | 'normal') => Promise<boolean>;
}

export function useDemoStream(): DemoStream {
  const mock = useMemo(() => isMockRequested(), []);
  const mockRef = useRef<DemoMock | null>(null);
  const [snapshot, setSnapshot] = useState<DemoSnapshot | null>(null);
  const [connection, setConnection] = useState<DemoConnection>(mock ? 'mock' : 'connecting');
  const offset = useRef(0); // server epoch seconds minus client epoch seconds

  const accept = useCallback((raw: unknown) => {
    const snap = parseSnapshot(raw);
    if (!snap) return false;
    offset.current = snap.now - Date.now() / 1000;
    setSnapshot(snap);
    return true;
  }, []);

  useEffect(() => {
    if (mock) {
      mockRef.current ??= createDemoMock();
      const tick = () => accept(mockRef.current!.snapshot(Date.now()));
      tick();
      const t = window.setInterval(tick, 1000);
      return () => window.clearInterval(t);
    }

    let disposed = false;
    let es: EventSource | null = null;
    let poll: number | undefined;

    const pollOnce = async () => {
      try {
        const r = await fetch(`${DEMO_URL}/demo/state`, { cache: 'no-store' });
        if (!r.ok) throw new Error(String(r.status));
        if (!disposed && accept(await r.json())) setConnection(c => (c === 'live' ? c : 'polling'));
      } catch {
        if (!disposed) setConnection('offline');
      }
    };
    const startPolling = () => {
      if (poll !== undefined) return;
      void pollOnce();
      poll = window.setInterval(() => void pollOnce(), POLL_MS);
    };
    const stopPolling = () => {
      if (poll !== undefined) window.clearInterval(poll);
      poll = undefined;
    };

    if (typeof EventSource === 'undefined') {
      startPolling();
    } else {
      es = new EventSource(`${DEMO_URL}/demo/stream`);
      es.addEventListener('state', ev => {
        if (accept((ev as MessageEvent).data)) {
          stopPolling();
          setConnection('live');
        }
      });
      // EventSource reconnects by itself; meanwhile keep the screen fresh by polling.
      es.onerror = () => {
        if (!disposed) {
          setConnection(c => (c === 'live' ? 'polling' : c));
          startPolling();
        }
      };
    }
    return () => {
      disposed = true;
      es?.close();
      stopPolling();
    };
  }, [mock, accept]);

  const serverNow = useCallback(() => Date.now() / 1000 + offset.current, []);

  const post = useCallback(
    async (path: string, body?: unknown): Promise<boolean> => {
      if (mock) {
        if (path === '/demo/reset') mockRef.current?.reset();
        else if (path === '/demo/inject') mockRef.current?.inject((body as { kind: 'heat' | 'humidity' | 'normal' }).kind);
        accept(mockRef.current!.snapshot(Date.now()));
        return true;
      }
      try {
        const r = await fetch(`${DEMO_URL}${path}`, {
          method: 'POST',
          headers: body ? { 'Content-Type': 'application/json' } : undefined,
          body: body ? JSON.stringify(body) : undefined,
        });
        if (r.ok) {
          void r
            .json()
            .then(accept)
            .catch(() => undefined);
        }
        return r.ok;
      } catch {
        return false;
      }
    },
    [mock, accept]
  );

  const reset = useCallback(() => post('/demo/reset'), [post]);
  const inject = useCallback((kind: 'heat' | 'humidity' | 'normal') => post('/demo/inject', { kind }), [post]);

  return { snapshot, connection, serverNow, reset, inject };
}
