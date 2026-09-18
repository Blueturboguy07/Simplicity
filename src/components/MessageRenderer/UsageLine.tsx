'use client';

import { useState } from 'react';
import { ChevronDown, ChevronUp } from 'lucide-react';
import { UsageBlock } from '@/lib/types';
import { cn } from '@/lib/utils';
import ProviderLogo from '../ui/ProviderLogo';
import { usePublikStatus } from '@/lib/hooks/usePublikStatus';
import { formatMicros } from '@/lib/publik/types';

/* Never renders raw floats like $0.00417382 — 2 sig figs above a cent,
   nearest tenth-of-a-cent below it. */
const formatCost = (n: number): string => {
  if (n <= 0) return '$0.00';
  if (n >= 0.01) return `$${n.toFixed(2)}`;
  return `$${n.toFixed(4)}`;
};

const formatTokens = (n: number): string => {
  if (n >= 1000) {
    const k = n / 1000;
    return `${k >= 10 ? Math.round(k) : k.toFixed(1)}k`;
  }
  return `${n}`;
};

const FreeChip = ({ className }: { className?: string }) => (
  <span
    className={cn(
      'rounded-full px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide bg-emerald-500/15 text-emerald-600 dark:text-emerald-400',
      className,
    )}
  >
    Free
  </span>
);

const UsageLine = ({ block }: { block: UsageBlock }) => {
  const [open, setOpen] = useState(false);
  const { totalCost, breakdown, free } = block.data;
  /* "publik balance $x" after a turn that went through publik API: the
     server-side cache is fed by the response headers; this only reads it.
     Fetched once per rendered usage line, never for a BYO-only turn. */
  const viaPublik = breakdown.some((e) => e.providerType === 'publik');
  const { status: publik } = usePublikStatus([viaPublik ? block.id : null]);
  const publikBalance =
    viaPublik && publik?.balanceMicros != null ? publik.balanceMicros : null;

  if (breakdown.length === 0) return null;

  const totalTokens = breakdown.reduce(
    (sum, e) => sum + e.inputTokens + e.outputTokens,
    0,
  );

  return (
    <div className="w-full">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="inline-flex items-center gap-1.5 text-xs text-black/50 dark:text-white/50 hover:text-black/70 dark:hover:text-white/70 transition-colors duration-200"
      >
        {free ? (
          <FreeChip />
        ) : (
          <span className="tabular-nums">~{formatCost(totalCost)}</span>
        )}
        <span>·</span>
        <span className="tabular-nums">{formatTokens(totalTokens)} tokens</span>
        {breakdown.length > 1 && (
          <>
            <span>·</span>
            <span>{breakdown.length} models</span>
          </>
        )}
        {publikBalance !== null && (
          <>
            <span>·</span>
            <span className="tabular-nums">
              publik balance {formatMicros(publikBalance)}
            </span>
          </>
        )}
        {open ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
      </button>

      {open && (
        <div className="mt-2 rounded-lg border border-light-200 dark:border-dark-200 bg-light-secondary dark:bg-dark-secondary divide-y divide-light-200 dark:divide-dark-200 overflow-hidden">
          {breakdown.map((entry) => (
            <div
              key={`${entry.providerId}-${entry.model}`}
              className="flex items-center justify-between gap-3 px-3 py-2 text-xs"
            >
              <div className="flex items-center gap-2 min-w-0">
                <ProviderLogo
                  providerKey={entry.providerType}
                  size={14}
                  className="text-black/60 dark:text-white/60 flex-shrink-0"
                />
                <span className="truncate text-black/80 dark:text-white/80 font-medium">
                  {entry.label}
                </span>
              </div>
              <div className="flex items-center gap-3 flex-shrink-0">
                <span className="text-black/40 dark:text-white/40 tabular-nums">
                  {entry.inputTokens.toLocaleString()} in ·{' '}
                  {entry.outputTokens.toLocaleString()} out
                </span>
                {entry.free ? (
                  <FreeChip />
                ) : entry.cost == null ? (
                  <span
                    className="text-black/30 dark:text-white/30"
                    title="No price data for this model"
                  >
                    —
                  </span>
                ) : (
                  <span className="text-black/70 dark:text-white/70 tabular-nums">
                    {formatCost(entry.cost)}
                  </span>
                )}
              </div>
            </div>
          ))}
          <div className="flex items-center justify-between gap-3 px-3 py-2 text-xs font-medium">
            <span className="text-black/60 dark:text-white/60">Total</span>
            <span className="text-black dark:text-white tabular-nums">
              {free ? 'Free' : formatCost(totalCost)}
            </span>
          </div>
        </div>
      )}
    </div>
  );
};

export default UsageLine;
