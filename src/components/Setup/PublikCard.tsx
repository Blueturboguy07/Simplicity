import ProviderLogo from '@/components/ui/ProviderLogo';
import { AlertCircle, Check, Loader2 } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import type { PublikAction } from '@/lib/hooks/usePublikStatus';
import {
  formatMicros,
  PUBLIK_ACCOUNT_URL,
  PUBLIK_PRICING_URL,
  PUBLIK_TERMS_URL,
  PublikStatus,
} from '@/lib/publik/types';

/* The packaged build's first-run card. Three faces, one component:
 *   pending      — the disclosure (cost + where prompts go) and the two
 *                  buttons; "Continue" is what mints the key [S4]
 *   active       — connected, with the balance line
 *   failed /     — unreachable, or this computer was removed from the
 *   disconnected   account; Retry / Reconnect, and always "use my own key"
 *
 * Copy rules (CONTRACT §1): "publik API" only; the rate and the R21
 * "most people spend under $2 a month" line, no hourly figure; dollars,
 * never tokens; the free balance comes from the server, never a constant.
 */

/* Shown to every install once, before anything is sent. */
export const Disclosure = ({ compact = false }: { compact?: boolean }) => (
  <div className="flex flex-col gap-2 text-[11px] sm:text-xs leading-relaxed text-black/60 dark:text-white/60">
    {!compact && (
      <p>
        Simplicity needs an AI model to work. By default it runs on{' '}
        <span className="font-medium text-black/80 dark:text-white/80">
          publik API
        </span>
        , so you can start right away without an account or a key.
      </p>
    )}
    <p>
      <span className="font-medium text-black/80 dark:text-white/80">
        Cost.
      </span>{' '}
      Every request is priced per use at 50% of the model&apos;s published list
      price, from your publik balance. You start with a small free balance. Most
      people spend under $2 a month. You can see every charge under each answer
      and at publikhq.com.
    </p>
    <p>
      <span className="font-medium text-black/80 dark:text-white/80">
        Where your prompts go.
      </span>{' '}
      Your questions and the pages Simplicity reads go through publik&apos;s
      servers to a shared model account. publik does not keep your prompts after
      the reply and never trains on them; the model provider may retain them
      briefly for abuse monitoring. You can switch to your own key at any time
      in Settings.
    </p>
  </div>
);

const weekLine = (s: PublikStatus) => {
  if (s.week.usedMicros === null) return null;
  const used = formatMicros(s.week.usedMicros);
  if (s.week.budgetMicros === null) return `${used} used this week`;
  return `This week ${used} of ${formatMicros(s.week.budgetMicros)}`;
};

export const StatusLine = ({ status }: { status: PublikStatus }) => {
  if (!status.connected) return null;
  const parts: string[] = [];
  if (status.balanceMicros !== null) {
    parts.push(
      status.claimState === 'anonymous' &&
        status.starterRemainingMicros !== null &&
        status.starterRemainingMicros > 0
        ? `${formatMicros(status.starterRemainingMicros)} of free balance left`
        : `${formatMicros(status.balanceMicros)} left`,
    );
  }
  const week = weekLine(status);
  if (week) parts.push(week);
  return (
    <p className="text-[10px] sm:text-xs text-black/50 dark:text-white/50 mt-0.5 tabular-nums">
      {status.claimState === 'claimed'
        ? 'Linked to your publik account'
        : 'Ready'}
      {parts.length > 0 && ` · ${parts.join(' · ')}`}
    </p>
  );
};

const PublikCard = ({
  status,
  busy,
  onAction,
}: {
  status: PublikStatus;
  busy: boolean;
  onAction: (action: PublikAction) => Promise<PublikStatus | undefined>;
}) => {
  const [pendingAction, setPendingAction] = useState<PublikAction | null>(null);

  const run = async (action: PublikAction) => {
    setPendingAction(action);
    try {
      const next = await onAction(action);
      if (action === 'accept' && next && next.state !== 'active') {
        toast.error(
          next.lastError
            ? `Could not reach publik API (${next.lastError}). Nothing was charged.`
            : 'Could not reach publik API. Nothing was charged.',
        );
      }
    } catch {
      toast.error('Something went wrong talking to Simplicity. Try again.');
    } finally {
      setPendingAction(null);
    }
  };

  const Button = ({
    action,
    primary,
    children,
  }: {
    action: PublikAction;
    primary?: boolean;
    children: React.ReactNode;
  }) => (
    <button
      type="button"
      disabled={busy}
      onClick={() => run(action)}
      className={
        primary
          ? 'flex flex-row items-center gap-1.5 rounded-lg bg-[#24A0ED] px-3 py-1.5 text-xs font-medium text-white hover:bg-[#1e8fd1] active:scale-95 transition-all disabled:opacity-60 disabled:active:scale-100'
          : 'text-[10px] sm:text-xs text-black/50 dark:text-white/50 hover:underline disabled:opacity-60'
      }
    >
      {pendingAction === action && (
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
      )}
      {children}
    </button>
  );

  const failed = status.state === 'pending' && status.lastError;
  const disconnected = status.state === 'disconnected';
  const active = status.state === 'active';

  return (
    <div className="mb-4 flex flex-col gap-3 rounded-xl border border-[#24A0ED]/40 bg-[#24A0ED]/5 px-3 md:px-4 py-3">
      <div className="flex flex-row items-center gap-3">
        <ProviderLogo
          providerKey="publik"
          size={24}
          className="text-black/80 dark:text-white/80 shrink-0"
        />
        <div className="min-w-0 flex-1">
          <div className="flex flex-row items-center gap-2">
            <p className="text-xs sm:text-sm font-medium text-black dark:text-white">
              publik API
            </p>
            <span className="rounded-full px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide bg-[#24A0ED]/15 text-[#24A0ED]">
              Default
            </span>
          </div>
          {active ? (
            <StatusLine status={status} />
          ) : (
            <p className="text-[10px] sm:text-xs text-black/50 dark:text-white/50 mt-0.5">
              {disconnected
                ? 'This computer was removed from your publik account.'
                : failed
                  ? 'publik API is unreachable right now. Nothing is being charged.'
                  : 'Nothing to paste. Ready in one click.'}
            </p>
          )}
        </div>
        {active && (
          <span className="flex shrink-0 flex-row items-center gap-1.5 text-xs font-medium text-[#24A0ED]">
            <Check className="h-4 w-4" strokeWidth={2.5} /> Connected
          </span>
        )}
        {(failed || disconnected) && (
          <AlertCircle className="h-4 w-4 shrink-0 text-amber-500" />
        )}
      </div>

      {!active && !disconnected && <Disclosure />}
      {active && !status.disclosureCurrent && <Disclosure compact />}

      <div className="flex flex-row flex-wrap items-center justify-between gap-2">
        {active ? (
          <div className="flex flex-row flex-wrap items-center gap-x-3 gap-y-1 text-[10px] sm:text-xs">
            <a
              href={status.topUpUrl ?? PUBLIK_ACCOUNT_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="text-[#24A0ED] hover:underline"
            >
              {status.claimState === 'claimed'
                ? 'Add credit'
                : 'Link this computer to your publik account'}
            </a>
            <a
              href={PUBLIK_PRICING_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="text-[#24A0ED] hover:underline"
            >
              How pricing works
            </a>
          </div>
        ) : disconnected ? (
          <Button action="reconnect" primary>
            Reconnect
          </Button>
        ) : failed ? (
          <Button action="retry" primary>
            Retry
          </Button>
        ) : (
          <Button action="accept" primary>
            Continue with publik API
          </Button>
        )}
        <Button action="decline">Use my own key instead</Button>
      </div>

      {!active && !disconnected && (
        <p className="text-[10px] text-black/40 dark:text-white/40">
          By continuing you agree to the{' '}
          <a
            href={PUBLIK_TERMS_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="underline hover:text-black/60 dark:hover:text-white/60"
          >
            publik API terms
          </a>
          .
        </p>
      )}
    </div>
  );
};

export default PublikCard;
