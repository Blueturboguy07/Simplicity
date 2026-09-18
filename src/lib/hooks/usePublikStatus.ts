'use client';

import { useCallback, useEffect, useState } from 'react';
import type { PublikStatus } from '@/lib/publik/types';

export type PublikAction = 'accept' | 'decline' | 'retry' | 'reconnect';

/* One small client for /api/publik: status and money, never the key. */
export const usePublikStatus = (deps: unknown[] = []) => {
  const [status, setStatus] = useState<PublikStatus | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch('/api/publik');
      if (!res.ok) throw new Error('status');
      setStatus(await res.json());
    } catch {
      setStatus(null);
    }
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
