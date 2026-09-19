'use client';

import { ChevronDown, ChevronRight, ExternalLink } from 'lucide-react';
import { useState } from 'react';
import {
  balanceLine,
  planCta,
  WHY_IT_COSTS,
  WHY_IT_COSTS_LABEL,
} from '@/lib/publik/cta';
import type { PublikStatus } from '@/lib/publik/types';

/* The three pieces CONTRACT §12.1 puts on every publik card, in order:
 *   (a) BalanceLine   — "<amount> of free starter usage", from the server
 *   (b) WhyItCosts    — the one-sentence justification (open on first run,
 *                       a "Why it costs money" toggle everywhere else)
 *   (c) PlanCtaLink   — the primary button; a real link so the URL is the
 *                       response's claim_url and the Electron shell opens
 *                       it in the system browser (setWindowOpenHandler)
 * Copy rule (CONTRACT §1): "publik API", dollars, never tokens. */

export const BalanceLine = ({
  status,
  className = '',
}: {
  status: PublikStatus;
  className?: string;
}) => {
  const line = balanceLine(status);
  if (!line) return null;
  return (
    <p
      data-testid="publik-balance-line"
      className={`text-xs sm:text-sm font-medium tabular-nums text-black/80 dark:text-white/80 ${className}`}
    >
      {line}
    </p>
  );
};

export const WhyItCosts = ({
  open: initiallyOpen = false,
  toggle = true,
}: {
  open?: boolean;
  toggle?: boolean;
}) => {
  const [open, setOpen] = useState(initiallyOpen);
  if (!toggle) {
    return (
      <p
        data-testid="publik-why-it-costs"
        className="text-[11px] sm:text-xs leading-relaxed text-black/60 dark:text-white/60"
      >
        {WHY_IT_COSTS}
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-1">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="inline-flex items-center gap-1 text-[10px] sm:text-xs text-black/50 dark:text-white/50 hover:text-black/70 dark:hover:text-white/70 transition-colors"
      >
        {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        {WHY_IT_COSTS_LABEL}
      </button>
      {open && (
        <p
          data-testid="publik-why-it-costs"
          className="text-[11px] sm:text-xs leading-relaxed text-black/60 dark:text-white/60"
        >
          {WHY_IT_COSTS}
        </p>
      )}
    </div>
  );
};

export const PlanCtaLink = ({
  status,
  surface,
  onClick,
  className = '',
}: {
  status: PublikStatus;
  surface: 'first-run' | 'settings';
  onClick?: () => void;
  className?: string;
}) => {
  const cta = planCta(status, surface);
  return (
    <a
      data-testid="publik-plan-cta"
      href={cta.href}
      target="_blank"
      rel="noopener noreferrer"
      onClick={onClick}
      className={`inline-flex flex-row items-center gap-1.5 rounded-lg bg-[#24A0ED] px-3 py-1.5 text-xs font-medium text-white hover:bg-[#1e8fd1] active:scale-95 transition-all ${className}`}
    >
      {cta.label}
      <ExternalLink className="h-3.5 w-3.5" />
    </a>
  );
};
