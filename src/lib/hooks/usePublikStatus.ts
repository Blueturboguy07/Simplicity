'use client';

import { useCallback, useEffect, useState } from 'react';
import type { PublikStatus } from '@/lib/publik/types';

export type PublikAction =
  | 'accept'
  | 'decline'
  | 'retry'
  | 'reconnect'
  | 'later';

/* Every instance of the hook hears every fetch: the usage line under an
   answer refreshes the status after a metered turn, and the balance banner
   at the top of the page picks the same reply up without a second request. */
const STATUS_EVENT = 'publik-status';
const broadcast = (status: PublikStatus) => {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(STATUS_EVENT, { detail: status }));
};

/* One small client for /api/publik: status and money, never the key. */
export const usePublikStatus = (deps: unknown[] = []) => {
  const [status, setStatus] = useState<PublikStatus | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch('/api/publik');
      if (!res.ok) throw new Error('status');
      const next = (await res.json()) as PublikStatus;
      setStatus(next);
      broadcast(next);
    } catch {
      setStatus(null);
    }
  }, []);

  useEffect(() => {
    const onStatus = (e: Event) => {
      const detail = (e as CustomEvent<PublikStatus>).detail;
      if (detail) setStatus(detail);
    };
    window.addEventListener(STATUS_EVENT, onStatus);
    return () => window.removeEventListener(STATUS_EVENT, onStatus);
  }, []);

  const act = useCallback(async (action: PublikAction) => {
    setBusy(true);
    try {
      const res = await fetch('/api/publik', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action }),
      });
      if (!res.ok) throw new Error(action);
      const next = (await res.json()) as PublikStatus;
      setStatus(next);
      broadcast(next);
      return next;
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  return { status, busy, refresh, act };
};
