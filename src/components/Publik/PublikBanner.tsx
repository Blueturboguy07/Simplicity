'use client';

import { ExternalLink, X } from 'lucide-react';
import { useState } from 'react';
import { usePublikStatus } from '@/lib/hooks/usePublikStatus';
import { bannerFor, type PublikBanner as Banner } from '@/lib/publik/cta';
import type { PublikStatus } from '@/lib/publik/types';

/* Non-blocking money banner (CONTRACT §12.3, task rule 3): shown when a
 * 402 arrived or the free starter is under 20% of what was granted. The
 * message comes from the response; the app adds exactly one link,
 * top_up_url. Dismissable per message; nothing here gates a request, and
 * the user's own providers keep working regardless. */

export const PublikBannerView = ({
  banner,
  onDismiss,
}: {
  banner: Banner;
  onDismiss?: () => void;
}) => (
  <div
    role="status"
    data-testid="publik-banner"
    className="mt-3 flex flex-row items-start gap-3 rounded-xl border border-amber-400/40 bg-amber-400/10 px-3 md:px-4 py-2.5"
  >
    <div className="min-w-0 flex-1 flex flex-col gap-1.5">
      <p className="text-xs sm:text-sm text-black/80 dark:text-white/80">
        {banner.message}
      </p>
      <a
        data-testid="publik-banner-link"
        href={banner.link.href}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex w-fit flex-row items-center gap-1.5 rounded-lg bg-[#24A0ED] px-3 py-1.5 text-xs font-medium text-white hover:bg-[#1e8fd1] active:scale-95 transition-all"
      >
        {banner.link.label}
        <ExternalLink className="h-3.5 w-3.5" />
      </a>
    </div>
    {onDismiss && (
      <button
        type="button"
        aria-label="Dismiss"
        onClick={onDismiss}
        className="shrink-0 rounded-md p-1 text-black/50 dark:text-white/50 hover:text-black/80 dark:hover:text-white/80"
      >
        <X size={14} />
      </button>
    )}
  </div>
);

export const bannerFromStatus = (status: PublikStatus | null) =>
  status ? bannerFor(status) : null;

const PublikBanner = () => {
  const { status } = usePublikStatus();
  const [dismissed, setDismissed] = useState<string | null>(null);
  const banner = bannerFromStatus(status);
  if (!banner || dismissed === banner.message) return null;
  return (
    <PublikBannerView
      banner={banner}
      onDismiss={() => setDismissed(banner.message)}
    />
  );
};

export default PublikBanner;
